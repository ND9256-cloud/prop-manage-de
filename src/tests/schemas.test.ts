import { validateSchemas } from "../../scripts/validate-schemas";

const EXPECTED_COUNT = 5;

const { validated, errors, warnings } = validateSchemas();

for (const warn of warnings) {
  console.warn(`WARN [${warn.check}] ${warn.file}: ${warn.message}`);
}

if (errors.length > 0) {
  for (const err of errors) {
    console.error(`FAIL [${err.check}] ${err.file}: ${err.message}`);
  }
  throw new Error(`Schema validation failed with ${errors.length} error(s)`);
}

if (validated !== EXPECTED_COUNT) {
  throw new Error(
    `Expected ${EXPECTED_COUNT} schemas but validated ${validated}`
  );
}

console.log(`\u2713 ${validated} schemas validated${warnings.length > 0 ? ` (${warnings.length} warnings)` : ""} (${EXPECTED_COUNT} expected)`);
