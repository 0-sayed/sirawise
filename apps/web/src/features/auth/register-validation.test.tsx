// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ForgotPasswordPage } from "./pages/forgot-password";
import { RegisterPage } from "./pages/register";
const state = vi.hoisted(() => ({ signup: vi.fn(), reset: vi.fn() }));
vi.mock("@/libs/auth/client", () => ({
	authClient: { requestPasswordReset: state.reset, signUp: { email: state.signup } },
}));
vi.mock("@tanstack/react-router", () => ({
	useSearch: () => ({}),
	useNavigate: () => vi.fn(),
	Link: ({ children }: { children: React.ReactNode }) => <a href="/auth/login">{children}</a>,
}));
vi.mock("@/features/locale/provider", () => ({ useUiLocale: () => ({ locale: "en-US" }) }));
vi.mock("./components/social-auth", () => ({ SocialAuth: () => null }));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});
function element(container: HTMLElement, selector: string) {
	const found = container.querySelector(selector);
	if (!found) throw new Error("Missing form element");
	return found;
}
function setup(email = "valid@example.com") {
	// Native constraint validation belongs to the browser; exercise the submit handler here.
	vi.spyOn(HTMLFormElement.prototype, "checkValidity").mockReturnValue(true);
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const view = render(
		<I18nProvider i18n={i18n}>
			<RegisterPage disableEmailAuth={false} />
		</I18nProvider>,
	);
	for (const [name, value] of Object.entries({ name: "Test", username: "testuser", email, password: "valid-password" }))
		fireEvent.change(element(view.container, `[name="${name}"]`), { target: { value } });
	fireEvent.click(screen.getByRole("checkbox"));
	return view;
}
it("blocks an email the server rejects before sending sign-up", async () => {
	const view = setup("a@a.a");
	fireEvent.submit(element(view.container, "form"));
	await screen.findByText("Enter a valid email address, such as name@example.com.");
	expect(state.signup).not.toHaveBeenCalled();
	expect(element(view.container, '[name="email"]')).toHaveAttribute("aria-invalid", "true");
});
it.each([
	["INVALID_EMAIL", "email"],
	["USER_ALREADY_EXISTS", "email"],
	["USERNAME_IS_ALREADY_TAKEN", "username"],
	["USERNAME_IS_INVALID", "username"],
	["PASSWORD_TOO_SHORT", "password"],
	["PASSWORD_TOO_LONG", "password"],
])("marks the correct field for %s", async (code, field) => {
	state.signup.mockResolvedValue({ error: { code } });
	const view = setup();
	fireEvent.submit(element(view.container, "form"));
	await waitFor(() => expect(element(view.container, `[name="${field}"]`)).toHaveAttribute("aria-invalid", "true"));
	expect(screen.getByRole("alert")).not.toHaveTextContent("We could not complete");
});

it("rejects invalid reset email before sending a request", async () => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	const view = render(
		<I18nProvider i18n={i18n}>
			<ForgotPasswordPage />
		</I18nProvider>,
	);
	fireEvent.change(element(view.container, '[name="email"]'), { target: { value: "a@a.a" } });
	fireEvent.submit(element(view.container, "form"));
	await screen.findByText("Enter a valid email address, such as name@example.com.");
	expect(state.reset).not.toHaveBeenCalled();
});
