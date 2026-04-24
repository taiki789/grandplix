// ExtendScript for Adobe Illustrator
// Reads job configuration from environment variable AI_JOB_PATH.

function fail(message) {
  throw new Error(message);
}

function readTextFile(filePath) {
  var file = new File(filePath);
  if (!file.exists) {
    fail("File not found: " + filePath);
  }
  if (!file.open("r")) {
    fail("Could not open file: " + filePath);
  }
  var content = file.read();
  file.close();
  return content;
}

function writeTextFile(filePath, text) {
  var file = new File(filePath);
  if (!file.open("w")) {
    fail("Could not open for write: " + filePath);
  }
  file.write(text);
  file.close();
}

function placeCenteredQr(doc, qrImagePath, qrSizePx) {
  var item = doc.placedItems.add();
  item.file = new File(qrImagePath);

  var currentW = item.width;
  var currentH = item.height;
  if (currentW <= 0 || currentH <= 0) {
    fail("QR image has invalid size.");
  }

  var scaleX = (qrSizePx / currentW) * 100;
  var scaleY = (qrSizePx / currentH) * 100;
  item.resize(scaleX, scaleY);

  var activeIndex = doc.artboards.getActiveArtboardIndex();
  var board = doc.artboards[activeIndex];
  var rect = board.artboardRect; // [left, top, right, bottom]

  var centerX = (rect[0] + rect[2]) / 2;
  var centerY = (rect[1] + rect[3]) / 2;

  var left = centerX - item.width / 2;
  var top = centerY + item.height / 2;
  item.position = [left, top];
}

function saveAsPdf(doc, outputPath) {
  var outputFile = new File(outputPath);
  var pdfOptions = new PDFSaveOptions();
  doc.saveAs(outputFile, pdfOptions);
}

function main() {
  var jobPath = $.getenv("AI_JOB_PATH");
  if (!jobPath) {
    fail("AI_JOB_PATH is not set.");
  }

  var raw = readTextFile(jobPath);
  var job = JSON.parse(raw);

  if (!job.templatePdfPath || !job.qrPath || !job.outputPdfPath) {
    fail("Required job fields are missing.");
  }

  var sourceFile = new File(job.templatePdfPath);
  if (!sourceFile.exists) {
    fail("Template PDF not found: " + job.templatePdfPath);
  }

  var doc = app.open(sourceFile);
  placeCenteredQr(doc, job.qrPath, Number(job.qrSize || 150));
  saveAsPdf(doc, job.outputPdfPath);

  doc.close(SaveOptions.DONOTSAVECHANGES);
}

try {
  main();
} catch (e) {
  var msg = "Illustrator script failed: " + e;
  $.writeln(msg);
  throw e;
}
