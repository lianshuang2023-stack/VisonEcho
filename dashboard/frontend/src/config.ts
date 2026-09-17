// Local mode is opt-in. Missing or any other value keeps Cognito authentication.
// Never put Azure credentials in VITE_* variables: Vite exposes them to browsers.
export const IS_LOCAL_BACKEND = import.meta.env.VITE_LOCAL_BACKEND === "true";
