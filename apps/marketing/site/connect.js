// The Connect page: Kurambit opens it with ?code=<the code the app shows>. The person signs in
// with GitHub (Clerk), checks the code matches, and approves; the app, polling, then gets its key.
const CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsua3VyYW1iaXQuY29tJA";
const CLERK_FRONTEND_API = "https://clerk.kurambit.com";

const status = document.querySelector("[data-connect-status]");
const say = (text) => {
  if (status) status.textContent = text;
};

const code = (new URLSearchParams(location.search).get("code") ?? "").toUpperCase();

// Clerk's documented script-tag setup (JavaScript quickstart): its UI bundle first, then clerk-js,
// then load() with that UI. clerk-js 5 is refused by Clerk as outdated.
const script = (src, publishableKey) =>
  new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = src;
    tag.crossOrigin = "anonymous";
    if (publishableKey) tag.dataset.clerkPublishableKey = publishableKey;
    tag.addEventListener("load", resolve);
    tag.addEventListener("error", () => reject(new Error("Sign-in could not load.")));
    document.head.append(tag);
  });

const loadClerk = async () => {
  await script(`${CLERK_FRONTEND_API}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await script(
    `${CLERK_FRONTEND_API}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
    CLERK_PUBLISHABLE_KEY,
  );
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return window.Clerk;
};

const approve = async (clerk) => {
  say("Connecting…");
  const token = await clerk.session.getToken();
  const answer = await fetch("/api/publish-device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "approve", userCode: code, token }),
  });
  document.querySelector("[data-connect-confirm]").hidden = true;
  if (answer.ok) say("Kurambit is connected. You can close this tab and publish from Kurambit.");
  else if (answer.status === 404)
    say("This code has expired or was already used. Start again from Kurambit.");
  else say("Kurambit could not be connected. Try again.");
};

const confirm = (clerk) => {
  say(
    `Signed in as ${clerk.user.username ?? clerk.user.primaryEmailAddress?.emailAddress ?? "you"}.`,
  );
  document.querySelector("[data-connect-code]").textContent = code;
  document.querySelector("[data-connect-confirm]").hidden = false;
  document
    .querySelector("[data-connect-approve]")
    .addEventListener("click", () => approve(clerk).catch((error) => say(String(error))), {
      once: true,
    });
};

const main = async () => {
  if (!/^[A-Z]{4}-[A-Z]{4}$/.test(code)) {
    say("Open this page from Kurambit: Export… → Publish on kurambit.com.");
    return;
  }
  const clerk = await loadClerk();
  if (clerk.user) return confirm(clerk);
  say("Sign in with GitHub so your Kurambit app can publish games.");
  clerk.mountSignIn(document.querySelector("[data-connect-signin]"), {
    forceRedirectUrl: location.href,
    signUpForceRedirectUrl: location.href,
  });
};

main().catch((error) => say(error instanceof Error ? error.message : String(error)));
