# Third-party notices

This application is distributed under AGPL-3.0-only; see LICENSE. The matching
application source is supplied with each release. Dependency licenses remain
with their respective packages in the application archive.

## AstrBot provider templates

`src/shared/astrbot-provider-templates.json` adapts provider configuration
templates from AstrBot, copyright its contributors, AGPL-3.0.

- Project: https://github.com/AstrBotDevs/AstrBot
- Pinned source commit: `48ba71ad7477fc81c8aa99ad241f41ef5b1c0bfe`
- Original license: `docs/licenses/ASTRBOT_AGPL-3.0.txt`
- Templates are adapted for this application's TypeScript model configuration.
  This is not an official AstrBot release.

## SillyTavern interoperability

Character-card, world-book and exchange behavior is independently adapted
against SillyTavern's AGPL-3.0 source at commit
`06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

- Project: https://github.com/SillyTavern/SillyTavern
- No upstream browser plugin entry point is executed by this application.
- Data-format compatibility does not imply full SillyTavern plugin runtime compatibility.

## Electron and bundled dependencies

Electron/Chromium notices are included with the Windows distribution. React,
Tiptap, docx, mammoth, JSZip, Zod and other production dependency notices are
retained in their installed packages. Research-only projects are not bundled.
