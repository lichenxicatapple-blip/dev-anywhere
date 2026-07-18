export function takeControlOfBrowserScrollRestoration(
  browserHistory: Pick<History, "scrollRestoration"> = window.history,
): void {
  browserHistory.scrollRestoration = "manual";
}
