# 14 — Website: Requirements

The public homepage at `PLATFORM_WEBSITE_URL` (the `APPS_DOMAIN` apex) is where a non-technical person starts. It walks them through connecting their AI to the platform and hands them a ready-made prompt for the app they want. The platform still writes no code: the prompt tells *their* AI what to build.

## Stories & acceptance criteria

### WEB-1 — Guided start
As someone without technical knowledge, I want a few simple steps that end with a prompt I can paste into my AI, so that I can get my app built without learning anything technical.

- **WEB-1.1** THE SYSTEM SHALL serve the homepage at `PLATFORM_WEBSITE_URL` as a step-by-step flow with a visible progress indicator and a way back to the previous step.
- **WEB-1.2** Step 1 SHALL ask which AI the person uses. Claude SHALL be selectable; other AIs (ChatGPT, Gemini, other) SHALL be shown as "coming soon" and not selectable.
- **WEB-1.3** Step 2 (Claude) SHALL show numbered instructions with a screenshot per step for adding the platform as a custom connector, including the connector name and the MCP server URL (`PLATFORM_API_ORIGIN/mcp`) with one-click copy buttons, signing in on the page Claude then opens (email + emailed code), and a "Done" button.
- **WEB-1.4** Step 3 SHALL ask what app they want (free text, required, up to `WEBSITE_APP_DESCRIPTION_MAX_CHARS`) and whether only they or several people will use it (a toggle, default "only me").
- **WEB-1.5** Step 4 SHALL show the generated prompt with a copy button and a button that opens a new Claude chat.
- **WEB-1.6** THE generated prompt SHALL include the app description verbatim, the audience choice turned into sign-in requirements (only me: the app is private to the person's email; several people: each person signs up with their email and sees their own data), and the platform workflow (read the guide first, build, deploy, fix failures, share the link, avoid technical questions). Signing in happens when connecting, so the prompt doesn't ask for it.
- **WEB-1.7** THE SYSTEM SHALL keep everything in the browser: the description is not sent to or stored by the platform.
- **WEB-1.8** `www.APPS_DOMAIN` SHALL redirect to the homepage (spec 09, RUN-1.2).

## Non-functional requirements

- Works on phones (single column, large touch targets) and desktop; readable without technical vocabulary.
- Loads fast: static assets only, no third-party scripts or trackers.
- Accessible: keyboard navigation, labelled controls, alt text on screenshots, sufficient contrast.

## Out of scope

- Instructions for AIs other than Claude (later, one per client).
- Accounts, payments or showing a user's apps on the website.
