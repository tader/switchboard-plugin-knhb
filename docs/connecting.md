---
title: Connecting KNHB Match Center
services: [knhb]
---

# Connecting KNHB Match Center

Add a KNHB Match Center connection and choose **Sign in with KNHB**. A separate Chrome or Edge window opens **on the computer running Switchboard**. Click **Inloggen**, sign in to your KNHB account and return to Match Center. Leave the page open until Switchboard finishes. Your usual browser profile is not used.

Administrators can set an executable path in the plugin’s `browserPath` setting. Browser sign-in needs a desktop session and a Switchboard version supporting browser pairing. On remote/headless servers or older versions, use session import below.

## Session import

1. In your own browser, open <https://www.knhb.nl/match-center#/> and sign in with **Inloggen**.
2. After returning to Match Center, open the browser’s developer tools. On the **Console** tab, run this expression yourself. Inspect it first: it copies only the KNHB sign-in record to your clipboard. Browser self-paste protections may apply; do not disable protections for scripts you do not understand.

```javascript
copy(JSON.stringify((() => {
  if (location.origin !== 'https://www.knhb.nl') throw Error('Open KNHB Match Center first');
  for (const key of Object.keys(sessionStorage)) {
    if (!key.startsWith('oidc.user:https://login.hockeyweerelt.nl:')) continue;
    const value = JSON.parse(sessionStorage.getItem(key));
    if (value.id_token) return {
      idToken: value.id_token,
      refreshToken: value.refresh_token,
      clientId: key.slice(key.lastIndexOf(':') + 1)
    };
  }
  throw Error('Sign in to KNHB and return to Match Center first');
})()));
```

3. In Switchboard choose **Import signed-in KNHB session**, paste into the secret field, and connect. Clear the clipboard afterwards. Do not send the value to an agent or another person.

Switchboard verifies the ID token against KNHB’s signing keys, issuer, known website client audience and expiry, registers a separate device, and checks access to the personal match feed before saving. It drops the submitted JSON field and stores only the required authentication credentials. Refresh is attempted when a refresh token is available. KNHB may expire or revoke sessions; reconnect when requested. Reimport a newly signed-in session if refresh is not available for your account.

## Public access

Choose **Public match data** to discover clubs, teams, competition schedules and results without a personal account. Public curated favorites are KNHB’s defaults. Sign in to retrieve your own favorites, matches and account-specific duties.

If KNHB responds with HTTP 429, wait before retrying and respect any `Retry-After` header. Avoid repeated connect attempts or polling data rapidly.
