# What the installer does (and how to check it yourself)

<!-- Hebrew translation: WHAT_IT_DOES.he.md. When you change one, change the other. -->
[עברית](WHAT_IT_DOES.he.md)

The installer is three plain-text files: `install.ps1` (Windows launcher), `install.sh` (Mac/Linux launcher) and `install.js` (all the real work). Nothing is compiled or obfuscated; what you read is what runs. You do not have to trust this page: section 3 shows how to verify every claim yourself or with an AI assistant.

## 1. The claims

**Files and software**
1. It writes only inside one folder in your home directory: `.ima-reply-tracking` (a private copy of Node.js if you had none, the `clasp` tool and npm's download cache, your project files, a small `state.json`, and `install.log`). It installs nothing system-wide and needs no administrator rights. The one thing outside that folder is whatever your operating system or browser creates by itself when the Google sign-in page opens (for example browser profile files on Windows).
2. Node.js, if it has to download it, comes from nodejs.org and is checked against Node's published SHA-256 before use. `clasp` (Google's own open-source Apps Script tool) is installed from npm at a pinned version.
3. The add-on files (`Code.gs`, `appsscript.json`) come from this project's GitHub release and always from the LATEST release, and are checked against that release's `SHA256SUMS.txt`; a file that does not match is never written anywhere. This catches a broken or partial download. It cannot catch a release changed on purpose (the checksum file sits next to the files): that rests on who can publish to the project's GitHub repo, the same people who run the add-on's library.

**Your Google account**
4. You sign in once, in your own browser, to Google's `clasp` app. It asks for clasp's standard permissions (Apps Script projects, Drive file metadata and files it creates, Cloud configuration, your email). The installer uses that sign-in for exactly four things: to read which account you are, to look in your Drive for an add-on copy you already have (it asks only for Apps Script files named "IMA Reply Tracking", and sees only their ids and dates, never their contents or any other file), to create your own Apps Script project if there is none, and to upload the two add-on files into it.
5. It never reads, searches or sends your email: no Gmail permission is requested at this stage.
6. At the end it **revokes** the sign-in at Google and deletes the token from your computer. If something fails midway, `install.js --forget` removes it.

**What leaves your computer** (this is the complete list)
7. To **Google**: the sign-in, creating/updating your project, revoking the sign-in.
8. To **GitHub**: downloading the release files.
9. To **npm** (and nodejs.org if needed): downloading `clasp` and, if needed, Node.
10. To the **IMA Reply Tracking server** (one address, set when the installer is published): a Google **ID token** (plus an invite code only if the group's server requires one; it currently does not). The ID token only proves which account you are; it cannot be used to access anything in your account. The server checks it with Google, adds your address to the member list, and does not keep the token.
11. There is no analytics, tracking or telemetry of any kind.

**What it does not do**
12. It does not touch any of your existing Drive files, Gmail messages or other Apps Script projects, and it does not change any computer or browser settings.
13. At the very end it prints how to get an optional Gemini key and, only if you answer `y`, opens that page (aistudio.google.com) in your browser. It never asks for, reads or stores a key: you paste it into the add-on yourself.
14. It cannot finish the last two steps for you: **Deploy -> Test deployments -> Install** and Gmail's permission prompt are done by you, in your browser, on Google's own pages.

## 2. What you will notice
- Google's consent screen for `clasp` lists nine permissions; all must stay ticked or it cannot create your project.
- Google emails you "You allowed clasp access ..." and later, after the last step, a similar notice for your own copy. Both are normal.
- On a fresh Google account the installer asks you to turn on "Google Apps Script API" once at https://script.google.com/home/usersettings and then waits for Google to notice (up to a few minutes).

## 3. How to verify it

**a. Read it.** Download the three files from the project's public GitHub repository, `install` folder (the release you were told to use). Total length is a few hundred lines.

**b. Check that what runs is what you read.** The command is the same for everyone and every release: it downloads the launcher from the repo's `main` branch. The launcher contains the SHA-256 of `install.js` and refuses to run any other `install.js`. The repo's `install/SHA256SUMS.txt` lists all three files. Check by hand:
- Windows PowerShell: `Get-FileHash install.js -Algorithm SHA256`
- Mac/Linux: `shasum -a 256 install.js`

and compare with `SHA256SUMS.txt` (and with the hash inside the launcher).

**c. Ask an AI assistant to check the claims against the code.** Paste the three files into your assistant after this prompt:

> You are a careful security reviewer. I will paste three files: install.ps1, install.sh and install.js. They are an installer that runs on a user's own computer. Do NOT assume they are safe. For EACH numbered claim below, read the code and answer HOLDS or DOES NOT HOLD, quoting the exact lines that prove it. Then separately list: (1) every network address the code can contact, (2) every place the code writes or deletes files, (3) every place a token, password or personal data could be logged, stored or sent, (4) any code that is hidden, encoded, downloaded and executed without a checksum, or that otherwise differs from what the claims say. Be strict: if something is only true under conditions, say which.
>
> Claims: (1) writes only inside a `.ima-reply-tracking` folder in the user's home directory (apart from files the OS or browser create themselves when the sign-in page opens), no admin rights, nothing system-wide; (2) Node.js is downloaded only from nodejs.org and verified against its published SHA-256, clasp is installed from npm at a pinned version; (3) the add-on files come from the latest GitHub release and are checked against that release's SHA256SUMS.txt before being written; (4) the Google sign-in is used only to identify the account, create the user's own Apps Script project and upload two files; (5) it never reads or sends the user's email; (6) the sign-in is revoked at Google and deleted locally at the end; (7) network traffic goes only to Google, GitHub, npm, nodejs.org and one reply-tracking-server address (the only other thing it can do is open the user's browser at https://aistudio.google.com/apikey if the user answers y; it does not contact that page itself); (8) the IMA Reply Tracking server receives only a Google ID token (and an invite code, if one was given with --code); (9) no analytics or telemetry; (10) it does not modify any other file, Drive item, Gmail message, Apps Script project or system setting; (11) it refuses to run an install.js whose SHA-256 does not match the one embedded in the launcher.

**What this cannot prove.** The review covers these three files. It trusts Google's `clasp` tool (open source, from npm), Google itself, and the IMA Reply Tracking server's operators, whose server code you can ask to see. The pinned versions and checksums make sure you get exactly the files the organizer published; they do not make the organizer's files good, which is what reading them is for.
