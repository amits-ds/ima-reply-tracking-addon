# IMA Reply Tracking

A Gmail add-on for IMA members. It records when you wrote to the IMA, when (and whether) it answered, and how you rate each answer, so the group can see how inquiries are handled.

**Start here:** [About, installation and help](https://amits-ds.github.io/ima-reply-tracking-addon/install/en/about.html) · [עברית](https://amits-ds.github.io/ima-reply-tracking-addon/install/he/about.html)

## Why trust us?
This is a volunteer tool that Google has not reviewed, and it reads your email. Don't take our word for what it does: [Why trust us?](install/WHY_TRUST_US.md) ([עברית](install/WHY_TRUST_US.he.md)) lists every promise with the place in the code that keeps it, and a prompt for checking the code with an AI assistant.

## Install
Follow the [install page](https://amits-ds.github.io/ima-reply-tracking-addon/install/en/install.html) ([עברית](https://amits-ds.github.io/ima-reply-tracking-addon/install/he/install.html)). It has one command for Windows and one for Mac, plus a manual route.
The installer always installs the [latest release](https://github.com/amits-ds/ima-reply-tracking-addon/releases/latest) and checks each file against that release's `SHA256SUMS.txt`.

## What is in this repository
| Path | What it is |
|---|---|
| `Code.gs`, `appsscript.json` | The add-on that is installed in your own Google account (also attached to each release) |
| `Library.gs` | The add-on's logic, shared by every copy: reading mail, building records, every network call (also attached to each release) |
| `install/install.ps1`, `install/install.sh`, `install/install.js` | The installer: the Windows and Mac launchers, and the script they run after checking its hash |
| `install/WHAT_IT_DOES.md` ([עברית](install/WHAT_IT_DOES.he.md)) | What the installer does, step by step, and how to check it yourself |
| `install/en/`, `install/he/` | The member pages: about, your data, install, using it |
| `library-version.txt`, `assets/` | The library version number and the add-on icon |

## Your data
What is uploaded, what is never uploaded, and who can see it: [Your data](https://amits-ds.github.io/ima-reply-tracking-addon/install/en/data.html) ([עברית](https://amits-ds.github.io/ima-reply-tracking-addon/install/he/data.html)).

## Contact
imareplytracker@gmail.com
