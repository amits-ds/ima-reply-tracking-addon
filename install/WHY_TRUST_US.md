# Why trust us? Don't. Check.

IMA Reply Tracking is a volunteer tool, not an app Google has reviewed. It asks for wide permissions (it reads your email), and you
have no store listing or company behind it to rely on. So we do not ask you to take our word for anything. Below is every promise we
make about what the add-on does in your account, each with the place in the code that keeps it. Give this page and the code to an
AI assistant (prompt at the end) or to a programmer you trust, and see for yourself whether what we say and what the code does are
the same thing.

(The installer, which runs once on your computer, has its own page: [WHAT_IT_DOES.md](WHAT_IT_DOES.md).)

## 1. The code you are checking
Two files run in your Google account. Both are public:
- `Code.gs`: the add-on itself (the cards you see, what it keeps in your account). In your own Apps Script project.
- `Library.gs`: the logic (reading your mail, building records, every network call). Shared by the group and used by every copy.

Get them from the [latest release](https://github.com/amits-ds/ima-reply-tracking-addon/releases/latest) (or `main` in this
repository). **Which copy actually runs:** the library is used in "development mode", so the people who run the project can update it
for everyone without a new install, and an update can reach you before it is published here. Every record you upload carries the
library version it was made with (`libVersion`), and every public release has the library file of that version. To check the exact
code running today, open `https://script.google.com/d/<libraryId>/edit` (the `libraryId` is in your `appsscript.json`); you have view
access, and you can paste that copy instead. (Release 2's `Library.gs` still has an old comment near the top saying it must never be
published; it predates the decision to publish it.)

The permissions are wider than what the code does: "connect to an external service" would allow any address, and "compose" would
allow deleting drafts. The limits in claims 1 and 3 are kept by the code, so they hold for the code you checked.

## 2. Our claims

### What it reads
1. **It cannot delete, archive, label or change your email, and never tries to.** Its permissions (`oauthScopes` in
   `appsscript.json`) are read-only for mail plus "compose" (drafts and sending). The code never calls any function that deletes,
   moves, labels, archives, stars or marks a message or a draft.
2. **It looks for conversations with the IMA, not your whole mailbox.** Its own searches look for mail to or from `ima.org.il` and
   the addresses in the group's Targets list (`unionQuery_`, `unionScanQuery_`, `isUnionAddress`, `findThreadsWithNewMessages`).
   Other searches run only when you type one yourself ("Find a conversation") or open the writing-style picker (your sent mail, to
   choose examples; `getStyleChoices`). Two more look-ups: the list of your drafts' conversation ids, only to ignore unsent drafts
   (`draftThreadIds_`), and a search of your sent mail by subject, to find a draft you created from the add-on and then sent in Gmail
   (`sentLike_`). The group's Targets list decides which addresses count as the IMA (`unionExtraAddrs_`).

### What leaves your account, and to where
3. **Only three destinations.** Every network call is in `Library.gs` (`UrlFetchApp.fetch`; `Code.gs` has none): (a) the group's log
   gateway (`GATEWAY_URL`, through `gatewayCall_`); (b) GitHub, to see whether a newer release exists
   (`getLatestContainerVersionFromGitHub`; a second GitHub check, `getLatestLibraryVersionFromGitHub`, is switched off by
   `LIBRARY_UPDATES_AUTOMATIC`); (c) Google's Gemini API, only if you added your own key (`geminiRequest_`, `fetchOne_`).
   Email it sends goes through Gmail to the people you chose (claim 10).
4. **A record has a fixed list of fields and never contains the text of an email.** Every record is built by `makeEvent` from
   `EVENT_FIELDS`: your address, the IMA addresses the inquiry went to, the topic you picked from the group's list, the kind of
   record, a value (your rating, or a status), the email's date, Gmail's conversation id, Gemini's suggested rating and its explanation (only if you use Gemini;
   the explanation is one sentence saying what the reply says, so it is a summary of the reply's content), your final rating, a record id, the email's Message-ID, the IMA sender's address, a SHA-256
   fingerprint of the original email (not the email), a fingerprint of the rubric, and, for IMA replies, the authenticity evidence
   described in claim 5. No body text, no attachment, no subject line except as claim 5 says.
5. **For IMA replies, it uploads the headers the IMA's mail server signed, not the body.** `authEvidenceFromRaw` copies the
   `DKIM-Signature` header and the headers it covers (usually From, Date, **Subject**, Message-ID; whatever the signature covers, which can include To and Cc), plus Gmail's own
   `Authentication-Results` header, so anyone can later check that
   the IMA really sent that reply. The body is not included.
6. **Only conversations you chose.** A conversation enters the log only after you track it (the triage card, the "Track" button
   beside an email, or a message you sent from the add-on), or when you restore your own history (`saveTriagePage_`,
   `onConfirmTopic`, `onCtxTrack`, `onSendFinal`, `settleDrafts_`, `onRestoreHistory`). Besides those records it uploads only
   counts (how many IMA conversations it saw and how many you track: `buildCoverageHeartbeatEvent`) and, if you fill it, your
   optional profile (pick-lists only: `buildProfileEvent`).
7. **Your identity.** Each call to the gateway carries Google's sign-in token for your account (`identityToken` in `Code.gs`), so
   the gateway knows the records are yours. It proves your email address; it is not a password and gives no access to your account.
8. **Gemini gets email text, only with your own key.** With a key, the text of tracked conversations (your messages and the IMA's
   replies, written up to each reply) goes to Google's Gemini API for a suggested rating (`judgeReplies`, `compactThread_`), and,
   when you ask for a rewrite, the draft and up to five emails you chose as style examples (`refineWithGemini`,
   `styleSampleTexts_`). Also with a key: when the add-on shows you IMA conversations you have not tracked yet (the triage card, including the results of a
   search you typed), it sends Gemini the subject and your own first message in each (up to 1,500 characters) to suggest a topic and
   a one-line gist (`triageSuggestions_` -> `suggestTriage`), before you decide anything. `measureThreadTokens` (counts tokens) is a
   developer tool the add-on never calls. The key is kept in your own project's settings (`getProp('GEMINI_API_KEY')`) and is never sent to the
   gateway. Without a key, no request is made.
9. **Full original emails are uploaded only if you turn it on.** The "evidence upload" sends the complete original message,
   attachments included (`uploadEvidenceThread`), and only when all three hold: the group has switched the feature on, you agreed on
   its consent card, and the conversation is one you track (`evOptedIn_` and its callers in `Code.gs`). Once a conversation is uploaded, its new
   messages are uploaded automatically by the background job, without asking again (`evQueueNew_`); turning it off in Settings
   stops that. Your agreement (its version, language and a fingerprint of the text) is sent to the gateway (`postEvidenceConsent`).
   It is off for the group today.

### What it does on its own
10. **It sends email only when you press Send, plus one reminder to yourself.** Messages to the IMA go out only from the confirmation
    step you click (`onSendFinal` -> `sendComposedEmail`, which calls `sendFollowup` for a follow-up), or you send a draft yourself in Gmail ("Open in Gmail" creates that draft in your mailbox: `onOpenInGmail`). **Note:** a follow-up is
    also copied (Cc) to everyone on the conversation's last message (`followupRecipients`), and the confirmation card shows only the
    main recipients, not that Cc list. The only automatic email is a weekly
    reminder from you to you, when items have waited a week, and you can switch it off (`maybeSendReminder_`, `sendReminder_`).
11. **One background job.** One timer every two hours (`lightCheckTrigger`, installed by `maybeScan_`): it looks for new messages in
    tracked conversations, once a day scans for new IMA conversations, records an automatic "no reply" when the IMA has not
    answered 14 days after your last message (`autoSilence_`), and uploads records that are waiting. Switching the daily check off in
    Settings removes the timer, which stops all of these, uploads included (they then happen only when you open the add-on).
12. **What it keeps is kept in your account.** The list of tracked conversations, records waiting to upload and your settings live in
    your own Apps Script project's storage (`PropertiesService`), which nobody else can read. Two exceptions: the library keeps the names of available Gemini models in its own per-user cache, and a
    conversation closed for 30 days is shrunk, its details read back from your own records in the group log when you open it
    (`hydrate_` -> `fetchHistory`). Error messages go to Google's error log (`exceptionLogging` in `appsscript.json`).
13. **What the group can change without a new install.** The group's settings (the Targets list, templates, topics, rubric and
    feature switches) are data the add-on downloads (`fetchConfig`, `useConfig`); they cannot add code (there is no `eval` or run-time code). The Targets list does widen what counts as the IMA, so it changes which
    conversations the add-on looks at (claim 2) and which messages count as replies. Code changes come through
    the library (section 1).

## 3. What reading the code cannot prove
The code decides what leaves your account. What happens after it arrives is on the group's servers, whose code is not in this
repository: who can read the log, how long it is kept, what the daily summaries contain. For those, [Your data](https://amits-ds.github.io/ima-reply-tracking-addon/install/en/data.html)
says what we do; that part rests on trust in the people who run the project, not on code you can read.

## 4. Ask an AI assistant
Use an assistant that can read long files (the two files are about 390 KB together; Claude or Gemini handle that, some free tiers do
not). Attach `Code.gs`, `Library.gs`, `appsscript.json` and this page, then paste:

> You are reviewing a Gmail add-on for a skeptical user. Attached are its source files (`Code.gs`, `Library.gs`, `appsscript.json`)
> and a page, WHY_TRUST_US.md, with numbered claims about what it does. For EACH claim in section 2: say whether the code confirms
> it, contradicts it, or does not let you tell; name the functions and quote the lines you relied on. Then look beyond the claims:
> list every network call, every Gmail action that sends, changes or deletes anything, every place email content or the user's data
> leaves the account, and every timer, and say whether each is covered by a claim. Report anything the page does not mention,
> anything that looks hidden or obfuscated, and anything that could send data somewhere else. Be strict: "probably fine" is not an
> answer.
