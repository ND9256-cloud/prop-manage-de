import {
  splitPdfIntoPages,
  stitchPageOutputs,
  aggregateResults,
  type PageResult,
} from "../../supabase/functions/process-document/page-extraction";

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

// We need pdf-lib for creating test PDFs
// Use dynamic import for compatibility
async function runTests() {
  const { PDFDocument } = await import("pdf-lib");

  // === Helper: create a PDF with N blank pages ===
  async function createTestPdf(pageCount: number): Promise<ArrayBuffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
      doc.addPage();
    }
    const bytes = await doc.save();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  // ─── SPLITTING TESTS ───────────────────────────────────────────

  console.log("\n=== splitPdfIntoPages ===");

  // 1. Single-page PDF → 1 page
  const singlePagePdf = await createTestPdf(1);
  const singleResult = await splitPdfIntoPages(singlePagePdf);
  expect("1-page PDF → 1 output", singleResult.length === 1);

  // Verify each output is a valid single-page PDF
  const verifyDoc1 = await PDFDocument.load(singleResult[0]);
  expect("1-page split: output has 1 page", verifyDoc1.getPageCount() === 1);

  // 2. 5-page PDF → 5 pages
  const fivePagePdf = await createTestPdf(5);
  const fiveResult = await splitPdfIntoPages(fivePagePdf);
  expect("5-page PDF → 5 outputs", fiveResult.length === 5);

  // Verify each split page is a valid single-page PDF
  for (let i = 0; i < 5; i++) {
    const verifyDoc = await PDFDocument.load(fiveResult[i]);
    expect(`5-page split: output ${i + 1} has 1 page`, verifyDoc.getPageCount() === 1);
  }

  // 3. Malformed PDF → controlled error
  let splitError: Error | null = null;
  try {
    await splitPdfIntoPages(new ArrayBuffer(10)); // garbage bytes
  } catch (err) {
    splitError = err instanceof Error ? err : new Error(String(err));
  }
  expect("Malformed PDF throws error", splitError !== null);

  // ─── STITCHING TESTS ──────────────────────────────────────────

  console.log("\n=== stitchPageOutputs ===");

  // 4. 3 successful pages → markers between them
  const threeSuccess: PageResult[] = [
    { pageNumber: 1, text: "Page one text", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
    { pageNumber: 2, text: "Page two text", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
    { pageNumber: 3, text: "Page three text", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
  ];
  const stitched3 = stitchPageOutputs(threeSuccess);
  expect("3 pages: contains Seite 1 marker", stitched3.includes("--- Seite 1 ---"));
  expect("3 pages: contains Seite 2 marker", stitched3.includes("--- Seite 2 ---"));
  expect("3 pages: contains Seite 3 marker", stitched3.includes("--- Seite 3 ---"));
  expect("3 pages: contains page one text", stitched3.includes("Page one text"));
  expect("3 pages: contains page three text", stitched3.includes("Page three text"));

  // 5. Page 2 failed, pages 1 + 3 succeeded → ERROR marker at page 2
  const withFailure: PageResult[] = [
    { pageNumber: 1, text: "Page one text", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
    { pageNumber: 2, text: "", stopReason: null, truncated: false, failed: true, errorMessage: "timeout" },
    { pageNumber: 3, text: "Page three text", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
  ];
  const stitchedFail = stitchPageOutputs(withFailure);
  expect("Failed page 2: ERROR marker present", stitchedFail.includes("[ERROR: page 2 extraction failed"));
  expect("Failed page 2: page 1 text intact", stitchedFail.includes("Page one text"));
  expect("Failed page 2: page 3 text intact", stitchedFail.includes("Page three text"));

  // 6. All pages failed → all ERROR markers
  const allFailed: PageResult[] = [
    { pageNumber: 1, text: "", stopReason: null, truncated: false, failed: true, errorMessage: "Haiku 529" },
    { pageNumber: 2, text: "", stopReason: null, truncated: false, failed: true, errorMessage: "timeout" },
    { pageNumber: 3, text: "", stopReason: null, truncated: false, failed: true, errorMessage: "Haiku 400" },
  ];
  const stitchedAllFail = stitchPageOutputs(allFailed);
  expect("All failed: 3 ERROR markers", (stitchedAllFail.match(/\[ERROR:/g) || []).length === 3);

  // 7. Empty page output (page with no text) → still shows marker with empty body
  const emptyPage: PageResult[] = [
    { pageNumber: 1, text: "", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
  ];
  const stitchedEmpty = stitchPageOutputs(emptyPage);
  expect("Empty page: Seite 1 marker present", stitchedEmpty.includes("--- Seite 1 ---"));
  expect("Empty page: no ERROR marker", !stitchedEmpty.includes("[ERROR:"));

  // 8. Out-of-order input → sorted by page number
  const outOfOrder: PageResult[] = [
    { pageNumber: 3, text: "Third", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
    { pageNumber: 1, text: "First", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
    { pageNumber: 2, text: "Second", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
  ];
  const stitchedOrder = stitchPageOutputs(outOfOrder);
  const idx1 = stitchedOrder.indexOf("--- Seite 1 ---");
  const idx2 = stitchedOrder.indexOf("--- Seite 2 ---");
  const idx3 = stitchedOrder.indexOf("--- Seite 3 ---");
  expect("Out-of-order: pages sorted correctly", idx1 < idx2 && idx2 < idx3);

  // ─── AGGREGATION TESTS ────────────────────────────────────────

  console.log("\n=== aggregateResults ===");

  // 9. All pages clean → confidence 90
  const agg1 = aggregateResults(threeSuccess);
  expect("All clean: confidence 90", agg1.confidence === 90);
  expect("All clean: anyTruncated false", agg1.anyTruncated === false);
  expect("All clean: failedPages empty", agg1.failedPages.length === 0);

  // 10. One page hit max_tokens → confidence 60, anyTruncated true
  const oneTruncated: PageResult[] = [
    { pageNumber: 1, text: "Page one", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
    { pageNumber: 2, text: "Truncated page", stopReason: "max_tokens", truncated: true, failed: false, errorMessage: null },
    { pageNumber: 3, text: "Page three", stopReason: "end_turn", truncated: false, failed: false, errorMessage: null },
  ];
  const agg2 = aggregateResults(oneTruncated);
  expect("One truncated: confidence 60", agg2.confidence === 60);
  expect("One truncated: anyTruncated true", agg2.anyTruncated === true);
  expect("One truncated: failedPages empty", agg2.failedPages.length === 0);

  // 11. One page failed → confidence 60, failedPages [2]
  const agg3 = aggregateResults(withFailure);
  expect("One failed: confidence 60", agg3.confidence === 60);
  expect("One failed: anyTruncated false", agg3.anyTruncated === false);
  expect("One failed: failedPages is [2]", agg3.failedPages.length === 1 && agg3.failedPages[0] === 2);

  // 12. All pages failed → confidence 0
  const agg4 = aggregateResults(allFailed);
  expect("All failed: confidence 0", agg4.confidence === 0);
  expect("All failed: anyTruncated false", agg4.anyTruncated === false);
  expect("All failed: failedPages is [1,2,3]",
    agg4.failedPages.length === 3 &&
    agg4.failedPages[0] === 1 &&
    agg4.failedPages[1] === 2 &&
    agg4.failedPages[2] === 3
  );

  // === Summary ===
  console.log(`\n${passCount + failCount} page-extraction assertions: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error("\nFailed:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  } else {
    console.log("✓ All page-extraction assertions passed");
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
