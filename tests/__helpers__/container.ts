/**
 * What a container stub hands back.
 *
 * `resolve<T>()` and `config.get<T>()` answer whatever type the caller names,
 * as the framework's do: the value is whatever was registered under the token.
 * Nothing can check that link at compile time — the framework cannot either —
 * and this overload is the one place in the tests that says so, instead of a
 * cast at every call.
 */
export function asRequested<T>(value: unknown): T;
export function asRequested(value: unknown): unknown {
	return value;
}
