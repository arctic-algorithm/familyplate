/**
 * FamilyPlate Cloud Functions
 *
 * Functions:
 *  1. sendDailyEmails  — Scheduled (every hour, checks if 8 AM in user's TZ)
 *  2. sendTestEmail    — HTTP POST, sends a test email to all enabled recipients
 *  3. confirmYesterday — HTTP GET, token-based one-click confirmation from email
 *  4. unsubscribe      — HTTP GET, disables email for a specific recipient
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { Resend } = require("resend");
const { v4: uuidv4 } = require("uuid");

admin.initializeApp();

// ── Secrets & Config ────────────────────────────────────────────
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// These can be set via firebase functions:config or environment
const FROM_EMAIL = process.env.FROM_EMAIL || "FamilyPlate <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "https://project-ush70.vercel.app";
const FIREBASE_DB_PATH = "/familyplate";

// ── Helpers ─────────────────────────────────────────────────────

/** Get the current hour in a given timezone */
function getCurrentHourInTZ(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    return parseInt(formatter.format(now), 10);
  } catch {
    return -1;
  }
}

/** Get today's date string in a given timezone */
function getTodayInTZ(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(now); // Returns YYYY-MM-DD
  } catch {
    return now.toISOString().split("T")[0];
  }
}

/** Get yesterday's date string in a given timezone */
function getYesterdayInTZ(timezone) {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(now);
  } catch {
    return now.toISOString().split("T")[0];
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeUrlForEmail(url) {
  const t = String(url).trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Rich slot line for email: title (escaped), optional description & link for home meals.
 * @returns {{ title: string, description: string | null, linkHref: string | null } | null}
 */
function getSlotEmailInfo(slot, meals, restaurants) {
  if (!slot || slot.type === "empty") return null;
  if (slot.type === "home") {
    const meal = meals.find((m) => m.id === slot.mealId);
    if (!meal) return null;
    const title = escapeHtml(meal.name);
    const description =
      typeof meal.description === "string" && meal.description.trim()
        ? escapeHtml(meal.description.trim())
        : null;
    const linkHref =
      typeof meal.link === "string" && meal.link.trim()
        ? sanitizeUrlForEmail(meal.link.trim())
        : null;
    return { title, description, linkHref };
  }
  if (slot.type === "restaurant") {
    const r = restaurants.find((x) => x.id === slot.mealId);
    if (!r) return null;
    return {
      title: escapeHtml(`${r.name} (eating out)`),
      description: null,
      linkHref: null,
    };
  }
  return null;
}

/** Format date for display */
function formatDateNice(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ── Email Template ──────────────────────────────────────────────

function buildEmailHTML({
  recipientName,
  householdName,
  todayDate,
  todayFormatted,
  slots, // { breakfast: { title, description?, linkHref? }|null, ... }
  planned,
  missing,
  confirmToken,
  unsubToken,
  yesterdayFormatted,
  yesterdayConfirmed,
}) {
  const appUrl = APP_URL;
  const confirmUrl = `${appUrl}/api/confirmYesterday?token=${confirmToken}`;
  const unsubUrl = `${appUrl}/api/unsubscribe?token=${unsubToken}`;

  const slotRows = ["breakfast", "lunch", "dinner"]
    .map((slot) => {
      const info = slots[slot];
      const filled = !!(info && info.title);
      const icon = slot === "breakfast" ? "🌅" : slot === "lunch" ? "☀️" : "🌙";
      const label = slot.charAt(0).toUpperCase() + slot.slice(1);

      if (filled) {
        const descBlock = info.description
          ? `<div style="margin-top:4px;font-size:12px;color:#64748b;line-height:1.4;max-width:280px;margin-left:auto;text-align:right;">${info.description}</div>`
          : "";
        const linkBlock = info.linkHref
          ? `<div style="margin-top:6px;text-align:right;"><a href="${info.linkHref}" style="color:#f97316;font-size:12px;font-weight:600;text-decoration:none;">Open link →</a></div>`
          : "";
        return `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;">
            <span style="font-size:20px;vertical-align:middle;">${icon}</span>
            <span style="margin-left:8px;color:#64748b;font-size:13px;font-weight:500;">${label}</span>
          </td>
          <td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;text-align:right;">
            <span style="color:#1e293b;font-weight:600;font-size:14px;">${info.title}</span>
            ${descBlock}
            ${linkBlock}
          </td>
        </tr>`;
      } else {
        return `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;">
            <span style="font-size:20px;vertical-align:middle;">${icon}</span>
            <span style="margin-left:8px;color:#64748b;font-size:13px;font-weight:500;">${label}</span>
          </td>
          <td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;text-align:right;">
            <span style="color:#f59e0b;font-size:13px;font-weight:500;">⚠ Not planned</span>
            <a href="${appUrl}?addSlot=${slot}&date=${todayDate}" style="margin-left:8px;color:#f97316;font-size:12px;font-weight:600;text-decoration:none;">Add ${label} →</a>
          </td>
        </tr>`;
      }
    })
    .join("");

  const summaryColor = missing > 0 ? "#f59e0b" : "#22c55e";
  const summaryText =
    missing > 0
      ? `${planned} meal${planned !== 1 ? "s" : ""} planned, ${missing} missing`
      : `All ${planned} meals planned — you're all set!`;

  const confirmSection = yesterdayConfirmed
    ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;text-align:center;margin-bottom:24px;">
        <span style="color:#16a34a;font-weight:600;font-size:14px;">✓ Yesterday's meals confirmed</span>
      </div>`
    : `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px;text-align:center;margin-bottom:24px;">
        <p style="color:#9a3412;font-size:13px;margin:0 0 12px;">Were yesterday's meals (${yesterdayFormatted}) correct?</p>
        <a href="${confirmUrl}" style="display:inline-block;background:#f97316;color:#ffffff;font-weight:600;font-size:14px;padding:10px 24px;border-radius:8px;text-decoration:none;">Confirm Yesterday's Meals ✓</a>
      </div>`;

  const quickAddSection =
    missing > 0
      ? `<div style="text-align:center;margin:20px 0;">
          <a href="${appUrl}?date=${todayDate}" style="display:inline-block;background:#f97316;color:#ffffff;font-weight:600;font-size:14px;padding:12px 32px;border-radius:10px;text-decoration:none;">Add Missing Meals</a>
        </div>`
      : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FamilyPlate Daily Summary</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <!-- Header -->
    <div style="text-align:center;padding:24px 0 16px;">
      <span style="font-size:36px;">🍽️</span>
      <h1 style="margin:8px 0 0;font-size:22px;color:#1e293b;font-weight:700;">FamilyPlate</h1>
      <p style="margin:4px 0 0;color:#94a3b8;font-size:13px;">${householdName}</p>
    </div>

    <!-- Main Card -->
    <div style="background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">
      <!-- Greeting -->
      <div style="padding:20px 20px 8px;">
        <p style="margin:0;color:#475569;font-size:14px;">Good morning, <strong>${recipientName}</strong>! Here's your meal plan for today.</p>
      </div>

      <!-- Date Header -->
      <div style="padding:8px 20px 16px;">
        <h2 style="margin:0;font-size:16px;color:#1e293b;">${todayFormatted}</h2>
        <p style="margin:4px 0 0;font-size:13px;color:${summaryColor};font-weight:500;">${summaryText}</p>
      </div>

      <!-- Meals Table -->
      <div style="padding:0 20px;">
        <table style="width:100%;border-collapse:collapse;">
          ${slotRows}
        </table>
      </div>

      <!-- Quick Add CTA -->
      ${quickAddSection}

      <!-- Separator -->
      <div style="border-top:1px solid #f1f5f9;margin:16px 20px 0;"></div>

      <!-- Yesterday Confirmation -->
      <div style="padding:16px 20px 20px;">
        ${confirmSection}
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:24px 0;">
      <a href="${appUrl}" style="color:#f97316;font-size:13px;font-weight:600;text-decoration:none;">Open FamilyPlate →</a>
      <p style="margin:12px 0 0;color:#cbd5e1;font-size:11px;">
        You're receiving this because you're part of the ${householdName} meal plan.
        <br><a href="${unsubUrl}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe from daily emails</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── Core: Send emails for the household ─────────────────────────

async function sendEmailsForHousehold(resendKey) {
  const resend = new Resend(resendKey);
  const db = admin.database();

  // Fetch all app data
  const snapshot = await db.ref(FIREBASE_DB_PATH).once("value");
  const data = snapshot.val();
  if (!data) {
    console.log("No data found in Firebase");
    return { success: false, message: "No data in database" };
  }

  const emailSettings = data.emailSettings || {};
  const familyEmails = emailSettings.familyEmails || [];
  const timezone = emailSettings.timezone || "America/New_York";
  const confirmations = emailSettings.confirmations || {};

  const enabledRecipients = familyEmails.filter((e) => e.enabled);
  if (enabledRecipients.length === 0) {
    console.log("No enabled email recipients");
    return { success: true, message: "No enabled recipients" };
  }

  const todayDate = getTodayInTZ(timezone);
  const yesterdayDate = getYesterdayInTZ(timezone);
  const todayFormatted = formatDateNice(todayDate);
  const yesterdayFormatted = formatDateNice(yesterdayDate);

  const meals = Array.isArray(data.meals) ? data.meals : [];
  const restaurants = Array.isArray(data.restaurants) ? data.restaurants : [];
  const dayPlan = (data.plans || {})[todayDate] || {};
  const yesterdayConfirmed = confirmations[yesterdayDate]?.confirmed || false;

  // Build slot data
  const slots = {
    breakfast: getSlotEmailInfo(dayPlan.breakfast, meals, restaurants),
    lunch: getSlotEmailInfo(dayPlan.lunch, meals, restaurants),
    dinner: getSlotEmailInfo(dayPlan.dinner, meals, restaurants),
  };

  const planned = Object.values(slots).filter(Boolean).length;
  const missing = 3 - planned;

  const householdName = data.household?.name || "Our Family";

  // Generate tokens and send emails
  const results = [];
  const tokens = {};

  for (const recipient of enabledRecipients) {
    const confirmToken = uuidv4();
    const unsubToken = uuidv4();

    // Store tokens in Firebase for validation
    tokens[confirmToken] = {
      type: "confirm",
      date: yesterdayDate,
      email: recipient.email,
      recipientId: recipient.id,
      createdAt: new Date().toISOString(),
      used: false,
    };
    tokens[unsubToken] = {
      type: "unsubscribe",
      email: recipient.email,
      recipientId: recipient.id,
      createdAt: new Date().toISOString(),
      used: false,
    };

    const html = buildEmailHTML({
      recipientName: recipient.name,
      householdName,
      todayDate,
      todayFormatted,
      slots,
      planned,
      missing,
      confirmToken,
      unsubToken,
      yesterdayFormatted,
      yesterdayConfirmed,
    });

    try {
      // Resend v3 returns { data, error } and does NOT throw on API errors — must check `error`.
      const { data, error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: [recipient.email],
        subject: `🍽️ ${householdName} — ${planned}/3 meals planned for ${todayFormatted}`,
        html,
      });
      if (error) {
        const msg =
          typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : JSON.stringify(error);
        results.push({ email: recipient.email, sent: false, error: msg });
        console.error(`Resend API error for ${recipient.email}:`, error);
      } else {
        results.push({
          email: recipient.email,
          sent: true,
          resendId: data?.id ?? null,
        });
        console.log(
          `Email accepted by Resend for ${recipient.email} id=${data?.id ?? "n/a"}`
        );
      }
    } catch (err) {
      results.push({ email: recipient.email, sent: false, error: err.message });
      console.error(`Failed to send to ${recipient.email}:`, err.message);
    }
  }

  // Save tokens to Firebase
  await db.ref(`${FIREBASE_DB_PATH}/emailTokens`).update(tokens);

  const sentCount = results.filter((r) => r.sent).length;
  return {
    success: sentCount > 0,
    message:
      sentCount === results.length
        ? `Sent ${sentCount}/${results.length} emails`
        : `Sent ${sentCount}/${results.length} emails (see results for errors)`,
    results,
  };
}

// ── Function 1: Scheduled Daily Emails ──────────────────────────
// Runs every hour, checks if it's 8 AM in the user's timezone

exports.sendDailyEmails = onSchedule(
  {
    schedule: "0 * * * *", // Every hour on the hour
    timeZone: "UTC",
    secrets: [RESEND_API_KEY],
    region: "us-central1",
  },
  async (event) => {
    const db = admin.database();

    // Read timezone from settings
    const tzSnapshot = await db
      .ref(`${FIREBASE_DB_PATH}/emailSettings/timezone`)
      .once("value");
    const timezone = tzSnapshot.val() || "America/New_York";
    const currentHour = getCurrentHourInTZ(timezone);

    console.log(
      `Current hour in ${timezone}: ${currentHour} (target: 8)`
    );

    if (currentHour !== 8) {
      console.log("Not 8 AM in user timezone, skipping");
      return;
    }

    // Check if we already sent today (prevent duplicates)
    const todayDate = getTodayInTZ(timezone);
    const lastSentSnap = await db
      .ref(`${FIREBASE_DB_PATH}/emailSettings/lastSentDate`)
      .once("value");
    if (lastSentSnap.val() === todayDate) {
      console.log("Already sent emails today, skipping");
      return;
    }

    const result = await sendEmailsForHousehold(RESEND_API_KEY.value());

    // Mark as sent for today
    await db
      .ref(`${FIREBASE_DB_PATH}/emailSettings/lastSentDate`)
      .set(todayDate);

    console.log("Daily email result:", result);
  }
);

// ── Function 2: Send Test Email (HTTP) ──────────────────────────

exports.sendTestEmail = onRequest(
  {
    cors: true,
    invoker: "public",
    secrets: [RESEND_API_KEY],
    region: "us-central1",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ success: false, message: "Method not allowed" });
      return;
    }

    try {
      const result = await sendEmailsForHousehold(RESEND_API_KEY.value());
      res.json(result);
    } catch (err) {
      console.error("Test email error:", err);
      res
        .status(500)
        .json({ success: false, message: "Internal error: " + err.message });
    }
  }
);

// ── Function 3: Confirm Yesterday (HTTP GET) ────────────────────

exports.confirmYesterday = onRequest(
  {
    cors: true,
    region: "us-central1",
  },
  async (req, res) => {
    const token = req.query.token;
    if (!token) {
      res.status(400).send(renderConfirmPage(false, "Missing token"));
      return;
    }

    const db = admin.database();
    const tokenSnap = await db
      .ref(`${FIREBASE_DB_PATH}/emailTokens/${token}`)
      .once("value");
    const tokenData = tokenSnap.val();

    if (!tokenData) {
      res.status(404).send(renderConfirmPage(false, "Invalid or expired link"));
      return;
    }

    if (tokenData.type !== "confirm") {
      res.status(400).send(renderConfirmPage(false, "Invalid token type"));
      return;
    }

    if (tokenData.used) {
      res
        .status(200)
        .send(renderConfirmPage(true, "Already confirmed — you're all set!"));
      return;
    }

    // Mark the day as confirmed
    const date = tokenData.date;
    await db.ref(`${FIREBASE_DB_PATH}/emailSettings/confirmations/${date}`).set({
      confirmed: true,
      timestamp: new Date().toISOString(),
      confirmedBy: tokenData.email,
    });

    // Mark token as used
    await db.ref(`${FIREBASE_DB_PATH}/emailTokens/${token}/used`).set(true);

    res.status(200).send(renderConfirmPage(true, "Yesterday's meals confirmed!"));
  }
);

// ── Function 4: Unsubscribe (HTTP GET) ──────────────────────────

exports.unsubscribe = onRequest(
  {
    cors: true,
    region: "us-central1",
  },
  async (req, res) => {
    const token = req.query.token;
    if (!token) {
      res.status(400).send(renderUnsubPage(false, "Missing token"));
      return;
    }

    const db = admin.database();
    const tokenSnap = await db
      .ref(`${FIREBASE_DB_PATH}/emailTokens/${token}`)
      .once("value");
    const tokenData = tokenSnap.val();

    if (!tokenData || tokenData.type !== "unsubscribe") {
      res.status(404).send(renderUnsubPage(false, "Invalid or expired link"));
      return;
    }

    // Find the recipient and disable their emails
    const emailsSnap = await db
      .ref(`${FIREBASE_DB_PATH}/emailSettings/familyEmails`)
      .once("value");
    const emails = emailsSnap.val() || [];

    // Find by recipientId or email
    let updated = false;
    const emailArray = Array.isArray(emails) ? emails : Object.values(emails);
    for (let i = 0; i < emailArray.length; i++) {
      if (
        emailArray[i] &&
        (emailArray[i].id === tokenData.recipientId ||
          emailArray[i].email === tokenData.email)
      ) {
        emailArray[i].enabled = false;
        updated = true;
        break;
      }
    }

    if (updated) {
      await db
        .ref(`${FIREBASE_DB_PATH}/emailSettings/familyEmails`)
        .set(emailArray);
      await db.ref(`${FIREBASE_DB_PATH}/emailTokens/${token}/used`).set(true);
      res
        .status(200)
        .send(
          renderUnsubPage(
            true,
            `${tokenData.email} has been unsubscribed from daily emails.`
          )
        );
    } else {
      res
        .status(404)
        .send(renderUnsubPage(false, "Could not find that email address."));
    }
  }
);

// ── Simple HTML pages for confirm/unsub responses ───────────────

function renderConfirmPage(success, message) {
  const icon = success ? "✅" : "❌";
  const color = success ? "#16a34a" : "#dc2626";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FamilyPlate</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;margin:0;padding:16px;}
.card{background:white;border-radius:16px;padding:40px;text-align:center;max-width:400px;box-shadow:0 1px 3px rgba(0,0,0,.1);}
</style></head><body>
<div class="card">
  <div style="font-size:48px;margin-bottom:16px;">${icon}</div>
  <h1 style="font-size:20px;color:#1e293b;margin:0 0 8px;">FamilyPlate</h1>
  <p style="font-size:15px;color:${color};margin:0 0 20px;">${message}</p>
  <a href="${APP_URL}" style="display:inline-block;background:#f97316;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Open FamilyPlate</a>
</div>
</body></html>`;
}

function renderUnsubPage(success, message) {
  const icon = success ? "📧" : "❌";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FamilyPlate — Unsubscribe</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;margin:0;padding:16px;}
.card{background:white;border-radius:16px;padding:40px;text-align:center;max-width:400px;box-shadow:0 1px 3px rgba(0,0,0,.1);}
</style></head><body>
<div class="card">
  <div style="font-size:48px;margin-bottom:16px;">${icon}</div>
  <h1 style="font-size:20px;color:#1e293b;margin:0 0 8px;">FamilyPlate</h1>
  <p style="font-size:15px;color:#475569;margin:0 0 20px;">${message}</p>
  <p style="font-size:13px;color:#94a3b8;">You can re-enable email reminders anytime from the app settings.</p>
  <a href="${APP_URL}" style="display:inline-block;margin-top:16px;background:#f97316;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Open FamilyPlate</a>
</div>
</body></html>`;
}
