# FamilyPlate Email Reminders — Setup Guide

## Overview

This adds daily 8 AM email reminders to FamilyPlate, built with:
- **Firebase Cloud Functions** (v2) for backend scheduling
- **Resend** for email delivery (free tier: 100 emails/day)
- **Token-based** one-click confirmation and unsubscribe links

## Prerequisites

1. **Firebase CLI** installed: `npm install -g firebase-tools`
2. **Firebase Blaze plan** (required for Cloud Functions — pay-as-you-go, Cloud Functions have a generous free tier)
3. **Resend account** at https://resend.com (free tier is fine)
4. **Node.js 18+**

## Step-by-Step Setup

### 1. Install Dependencies

```bash
cd functions
npm install
```

### 2. Set Up Resend

1. Sign up at https://resend.com
2. Go to **API Keys** and create a new key
3. Store the key as a Firebase secret:

```bash
firebase functions:secrets:set RESEND_API_KEY
# Paste your Resend API key when prompted
```

4. For production emails, verify your domain in Resend's dashboard.
   For testing, you can use `onboarding@resend.dev` as the sender (Resend's test address).

### 3. Configure Environment Variables

Set these in your Firebase project (or in `functions/.env` for local development):

```bash
# In functions/.env (for local dev)
FROM_EMAIL=FamilyPlate <onboarding@resend.dev>
APP_URL=https://your-app.vercel.app
FIREBASE_DB_URL=https://familyplate-b4ba9-default-rtdb.firebaseio.com
```

For production, set environment variables via Firebase:
```bash
firebase functions:config:set app.url="https://your-app.vercel.app" app.from_email="FamilyPlate <meals@yourdomain.com>"
```

### 4. Deploy Cloud Functions

```bash
# From the project root (where firebase.json is)
firebase deploy --only functions
```

This deploys 4 functions:
- `sendDailyEmails` — Scheduled, runs hourly, sends at 8 AM in your timezone
- `sendTestEmail` — HTTP POST endpoint for testing from the app
- `confirmYesterday` — HTTP GET, handles one-click confirmation from emails
- `unsubscribe` — HTTP GET, handles unsubscribe links

### 5. Update the App with Cloud Functions URL

After deploying, Firebase will show your functions URLs. Update the app to use them.

**Option A: If hosting on Vercel** (current setup)

Add this to your `index.html` before the main script tag:
```html
<script>
  window.CLOUD_FUNCTIONS_URL = "https://us-central1-familyplate-b4ba9.cloudfunctions.net";
</script>
```

The "Send Test Email" button in Settings will use this URL.

For the confirmation and unsubscribe links in emails, update `APP_URL` in the Cloud Functions environment to point to your Cloud Functions URL pattern. The email template already uses these patterns:
- Confirm: `{APP_URL}/api/confirmYesterday?token=...`
- Unsubscribe: `{APP_URL}/api/unsubscribe?token=...`

**Option B: If migrating to Firebase Hosting**

The `firebase.json` already includes rewrite rules that route `/api/*` to the corresponding Cloud Functions. Deploy hosting:
```bash
firebase deploy --only hosting,functions
```

### 6. Configure in the App

1. Open FamilyPlate and go to **Settings**
2. Scroll to **Email Reminders**
3. Set your **timezone**
4. Add family member email addresses
5. Toggle reminders on/off per person
6. Click **Send Test Email** to verify everything works

## How It Works

### Daily Schedule
- The `sendDailyEmails` function runs every hour on the hour
- It checks if it's 8:00 AM in the configured timezone
- If yes, and emails haven't been sent today, it sends to all enabled recipients
- A `lastSentDate` flag prevents duplicate sends

### Email Content
Each email includes:
- Today's meal plan overview (breakfast, lunch, dinner)
- Visual indicators for missing/empty slots
- A summary line (e.g., "2 meals planned, 1 missing")
- **Confirm Yesterday** button (one-click, no login needed)
- **Add Missing Meals** button (deep links to the app)
- Unsubscribe link in footer

### Token-Based Actions
- Each email generates unique UUID tokens for confirm and unsubscribe
- Tokens are stored in Firebase at `/familyplate/emailTokens/`
- Tokens are single-use (marked `used: true` after first click)
- No authentication required — the token IS the auth

### Data Schema Additions
```
emailSettings: {
  familyEmails: [
    { id: string, name: string, email: string, enabled: boolean }
  ],
  timezone: string,           // e.g., "America/New_York"
  confirmations: {
    "YYYY-MM-DD": {
      confirmed: boolean,
      timestamp: string,
      confirmedBy: string     // email that confirmed
    }
  },
  lastSentDate: string        // prevents duplicate daily sends
}

emailTokens: {
  "<uuid>": {
    type: "confirm" | "unsubscribe",
    date: string,             // for confirm tokens
    email: string,
    recipientId: string,
    createdAt: string,
    used: boolean
  }
}
```

## Testing Checklist

- [ ] Add a family member email in Settings
- [ ] Click "Send Test Email" — verify email arrives
- [ ] Check email renders on mobile (Gmail, Apple Mail)
- [ ] Check email renders on desktop (Gmail, Outlook)
- [ ] Click "Confirm Yesterday's Meals" in the email — verify confirmation page
- [ ] Click confirm again — verify "Already confirmed" message
- [ ] Click "Add Missing Meals" — verify it opens the app
- [ ] Click unsubscribe — verify the person is disabled in Settings
- [ ] Re-enable them in Settings and send another test
- [ ] Verify timezone selector works (change TZ and check email timing)

## Troubleshooting

**"Cloud Functions URL not configured"**
- Set `window.CLOUD_FUNCTIONS_URL` in index.html

**Test email fails with "No enabled recipients"**
- Make sure at least one family member has the toggle enabled

**Emails going to spam**
- Verify your domain in Resend
- Use a custom FROM address (not onboarding@resend.dev for production)

**Scheduled function not firing**
- Check Firebase Functions logs: `firebase functions:log`
- Ensure Blaze plan is active
- Check timezone is correct

**Token expired/invalid**
- Tokens are stored indefinitely but marked as used after first click
- To clean up old tokens, you can periodically delete entries older than 7 days

## Costs

- **Resend free tier:** 100 emails/day, 3,000/month
- **Firebase Cloud Functions:** ~125,000 free invocations/month (hourly check = ~720/month)
- **Firebase Realtime Database:** 1 GB storage, 10 GB/month transfer free
- For a typical family (4 members, daily emails) this runs well within free tiers.
