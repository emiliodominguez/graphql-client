/** @type {import('jest').Config} */
export default {
	clearMocks: true,
	collectCoverage: true,
	coverageDirectory: "coverage",
	coverageReporters: ["json", "text", "lcov", "clover"],
	modulePathIgnorePatterns: ["<rootDir>/dist/"],
	prettierPath: require.resolve("prettier-2"),
};

