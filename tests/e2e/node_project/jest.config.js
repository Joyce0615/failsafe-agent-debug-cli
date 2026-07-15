// Fixture Jest config so a minimal-repro selector command
// (`jest <file> -t "<name>"`, no --testMatch) still discovers the
// `.fixture-test.js` files. The e2e capture command passes `--config='{}'`,
// which overrides this file, so it only affects the repro/verify path.
module.exports = {
	testMatch: ["**/*.fixture-test.js"],
};
