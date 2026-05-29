# Operation Hot Task — Team Integration Brief

## What this is

Operation Hot Task is our internal loan-task board (create, claim,
review, complete loan check tasks) running as a Microsoft Teams app.
Right now it runs in a test mode where you pick which user you are from
a dropdown. We're moving it to real Teams sign-in so every person is
their own actual account, and rolling it out to the whole team.

## What's changing

- **No more user dropdown.** When you open the app it knows who you are
  from your Teams identity automatically.
- **Real accounts.** Tasks you create or are assigned show your real
  name; "your" tasks are actually yours.
- **Notifications stay.** The team channel still gets a post when a task
  is created, claimed, or completed. You'll also get a direct message
  from the app's bot when something needs your attention.
- **Automatic updates.** Once the app is published to our org's Teams
  catalog, future updates roll out to everyone automatically — no
  reinstalling.

## What we need from IT / the Teams admin

This is the gating item — the rest can't proceed without it. We need a
dedicated app registration created in Entra (Azure AD) and a set of
permissions consented. Full request:

1. **Create an app registration** named `oht-teams-publisher`
   (Entra admin center → App registrations → New registration,
   single tenant).
2. **Add these Microsoft Graph _Application_ permissions** to it:
   - `AppCatalog.ReadWrite.All` — publish app updates to the org catalog
   - `User.Read.All` — read user profiles to set up accounts
   - `TeamMember.Read.All` — list team members to assign roles
   - `TeamsActivity.Send` — send in-Teams notifications
   - `TeamsAppInstallation.ReadWriteForUser.All` — install the app for
     users automatically
3. **Grant admin consent** for the tenant (this is the admin-only step).
4. **Create a client secret** and send us: Application (client) ID,
   Directory (tenant) ID, and the secret value.
5. **Publish the app to the org catalog** (Teams Admin Center →
   Teams apps → Manage apps → Upload) so it appears under
   "Built for your org" and updates automatically.
6. When we send the separate **Teams Tab app registration**, grant
   **tenant-wide admin consent** for its `access_as_user` scope so
   nobody gets a sign-in consent popup.

Optional but recommended: a **Teams app setup policy** that pins
Operation Hot Task for the team so it shows up without anyone hunting
for it.

## What end users do

- One-time: add the app from Teams ("Built for your org") — or it gets
  pinned for you automatically if the setup policy is used.
- After that: nothing. Updates are automatic. Sign-in is automatic
  (your Teams identity).
- If you previously added a personal/sideloaded copy of the app, remove
  that one copy once, then use the org version.

## Roles

Each person gets one or more roles: **Loan Officer**, **File Checker**,
or **Admin**. We'll pull the team roster and confirm each person's role
before go-live — expect a quick "what's your role" check-in.

## Rollout order

1. Admin completes the request above (app registration + consents).
2. We wire up real Teams sign-in and deploy.
3. We confirm everyone's role and seed accounts.
4. App is published to the org catalog; team installs / gets it pinned.
5. Test mode (user dropdown) is removed.

## Timeline

Engineering work is roughly 3–4 days once the admin request is done.
The admin request is the long pole — please prioritize it.

## Questions

Route to Tyler.
