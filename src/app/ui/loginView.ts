import { api, errorMessage } from "../api.ts";

/** Full-page password form; `onSuccess` is invoked after a 200 so the caller can re-bootstrap. */
export function renderLogin(root: HTMLElement, onSuccess: () => void): void {
  root.textContent = "";
  const page = document.createElement("div");
  page.className = "login-page";
  const card = document.createElement("form");
  card.className = "login-card";
  const h1 = document.createElement("h1");
  h1.textContent = "webscrcpy";

  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = "Password";
  label.htmlFor = "login-password";
  const input = document.createElement("input");
  input.id = "login-password";
  input.className = "input";
  input.type = "password";
  input.required = true;
  input.autocomplete = "current-password";
  field.append(label, input);

  const error = document.createElement("p");
  error.className = "error-text";
  error.style.minHeight = "1.4em";
  error.style.margin = "0 0 12px";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn btn-primary";
  submit.textContent = "Sign in";
  submit.style.width = "100%";
  submit.style.justifyContent = "center";
  card.append(h1, field, error, submit);
  page.appendChild(card);
  root.appendChild(page);
  input.focus();

  card.addEventListener("submit", (ev) => {
    ev.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    void (async () => {
      try {
        const res = await api.auth.login({ password: input.value });
        if (res.ok) {
          onSuccess();
          return;
        }
        if (res.reason === "locked") {
          const secs = Math.max(1, Math.ceil((res.retryAfterMs ?? 0) / 1000));
          error.textContent = `locked (retry in ${secs}s)`;
        } else {
          error.textContent = "invalid password";
        }
        input.value = "";
        input.focus();
      } catch (err) {
        error.textContent = errorMessage(err);
      } finally {
        submit.disabled = false;
      }
    })();
  });
}
