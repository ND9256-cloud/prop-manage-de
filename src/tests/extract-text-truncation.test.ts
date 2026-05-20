import { classifyOcrResponse } from "../../supabase/functions/process-document/ocr-result";

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function expect(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// === 1. Happy path PDF (stop_reason end_turn) ===
const r1 = classifyOcrResponse(
  { content: [{ text: "Mietvertrag zwischen..." }], stop_reason: "end_turn" },
  90,
);
expect("PDF end_turn: confidence stays 90", r1.confidence === 90);
expect("PDF end_turn: truncated false", r1.truncated === false);
expect("PDF end_turn: text extracted", r1.text === "Mietvertrag zwischen...");
expect("PDF end_turn: stopReason preserved", r1.stopReason === "end_turn");

// === 2. Happy path PDF (stop_reason missing) ===
const r2 = classifyOcrResponse(
  { content: [{ text: "Some text" }] },
  90,
);
expect("PDF missing stop_reason: confidence stays 90", r2.confidence === 90);
expect("PDF missing stop_reason: truncated false", r2.truncated === false);
expect("PDF missing stop_reason: stopReason null", r2.stopReason === null);

// === 3. Truncated PDF (stop_reason max_tokens) ===
const r3 = classifyOcrResponse(
  { content: [{ text: "Truncated text here" }], stop_reason: "max_tokens" },
  90,
);
expect("PDF max_tokens: confidence drops to 60", r3.confidence === 60);
expect("PDF max_tokens: truncated true", r3.truncated === true);
expect("PDF max_tokens: text still returned", r3.text === "Truncated text here");

// === 4. Happy path image (stop_reason end_turn, nominal 85) ===
const r4 = classifyOcrResponse(
  { content: [{ text: "Image OCR text" }], stop_reason: "end_turn" },
  85,
);
expect("Image end_turn: confidence stays 85", r4.confidence === 85);
expect("Image end_turn: truncated false", r4.truncated === false);

// === 5. Truncated image (stop_reason max_tokens, nominal 85) ===
const r5 = classifyOcrResponse(
  { content: [{ text: "Partial image text" }], stop_reason: "max_tokens" },
  85,
);
expect("Image max_tokens: confidence drops to 60", r5.confidence === 60);
expect("Image max_tokens: truncated true", r5.truncated === true);

// === 6. Empty content array ===
const r6 = classifyOcrResponse(
  { content: [], stop_reason: "end_turn" },
  90,
);
expect("Empty content: text is empty string", r6.text === "");
expect("Empty content: no crash, truncated false", r6.truncated === false);

// === 7. Missing content field entirely ===
const r7 = classifyOcrResponse(
  { stop_reason: "end_turn" },
  90,
);
expect("Missing content: text is empty string", r7.text === "");
expect("Missing content: no crash", r7.truncated === false);

// === 8. Other stop_reasons (tool_use, stop_sequence) ===
const r8a = classifyOcrResponse(
  { content: [{ text: "Tool text" }], stop_reason: "tool_use" },
  90,
);
expect("tool_use: not truncated", r8a.truncated === false);
expect("tool_use: confidence stays 90", r8a.confidence === 90);

const r8b = classifyOcrResponse(
  { content: [{ text: "Seq text" }], stop_reason: "stop_sequence" },
  85,
);
expect("stop_sequence: not truncated", r8b.truncated === false);
expect("stop_sequence: confidence stays 85", r8b.confidence === 85);

// === Summary ===
console.log(`\n${passCount + failCount} extract-text-truncation assertions: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error("\nFailed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
} else {
  console.log("✓ All extract-text-truncation assertions passed");
}
