// ============================================================
// Only two things live here now. Everything else -- machines,
// supervisors, reasons, session timeout -- is managed from the
// in-app Settings screen (tap the gear icon after logging in)
// and stored in your Google Sheet, so routine changes never
// require editing this file or re-uploading to GitHub.
// ============================================================

const CONFIG = {

  // Paste the Web App URL from Code.gs deployment (see DEPLOY_GUIDE.md).
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzjAkG8cjXmEFfmND22xxGjxxWeMTmGeATfkvS3gcyZA1j7hRn8hP9tanWlH6nMHhHnCQ/exec",

  // Must match SECRET_TOKEN in Code.gs exactly.
  SECRET_TOKEN: "MAFPL_2026",

  // Digits in a supervisor / admin PIN. Change this only if you
  // want a different PIN length app-wide (rare).
  PIN_LENGTH: 4
};
