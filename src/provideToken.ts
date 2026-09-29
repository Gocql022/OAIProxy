// Compatibility exports for existing callers. All accounting lives in the shared estimator.
export {
	BaseTokensPerMessage,
	BaseTokensPerName,
	countMessageTokens,
	countMessageTokenDetails,
	countToolTokens,
	textTokenLength,
	type MessageTokenDetails,
} from "./tokenEstimator";
