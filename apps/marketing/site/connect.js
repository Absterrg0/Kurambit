// The Connect page: the Kurambit app on this computer opens it with ?state=<s>&port=<p>. The
// person signs in with GitHub (Clerk); the page mints a publish key and posts it back to the app's
// own server on 127.0.0.1:<port>, which checks the state it made.
const CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsua3VyYW1iaXQuY29tJA";
const CLERK_FRONTEND_API = "https://clerk.kurambit.com";

const status = document.querySelector("[data-connect-status]");
const say = (text) => {
  if (status) status.textContent = text;
};

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "";
const port = Number(params.get("port"));

const loadClerk = () =>
  new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${CLERK_FRONTEND_API}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
    script.crossOrigin = "anonymous";
    script.dataset.clerkPublishableKey = CLERK_PUBLISHABLE_KEY;
    script.addEventListener("load", () => resolve(window.Clerk));
    script.addEventListener("error", () => reject(new Error("Sign-in could not load.")));
    document.head.append(script);
  });

const connect = async (clerk) => {
  say("Connecting your app…");
  const token = await clerk.session.getToken();
  const minted = await fetch("/api/publish-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!minted.ok) throw new Error("Your app could not be connected. Try again.");
  const { key, login } = await minted.json();
  const form = document.querySelector("[data-connect-form]");
  form.action = `http://127.0.0.1:${port}/api/game/publish/connected`;
  form.elements.namedItem("state").value = state;
  form.elements.namedItem("key").value = key;
  form.elements.namedItem("login").value = login ?? "";
  form.submit();
};

const main = async () => {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state) || !(port > 0 && port < 65536)) {
    say("Open this page from Kurambit: Export… → Publish.");
    return;
  }
  const clerk = await loadClerk();
  await clerk.load();
  if (clerk.user) return connect(clerk);
  say("Sign in with GitHub so your Kurambit app can publish games.");
  clerk.mountSignIn(document.querySelector("[data-connect-signin]"), {
    forceRedirectUrl: location.href,
    signUpForceRedirectUrl: location.href,
  });
};

main().catch((error) => say(error instanceof Error ? error.message : String(error)));
