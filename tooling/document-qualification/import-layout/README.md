# PDF import layout fixtures

The app PDFs use Forme 0.31.0, the bundled Noto Sans Arabic 2.009 font, and the local Noto Sans fallback. The mixed app PDF uses the two-column Azurill template. LibreOffice exports the synthetic Word-compatible DOCX in this directory. The native directory contains the Chromium PDFs and original HTML.

The source resumes and native HTML define the expected text and field associations. The manifest records the producer and SHA-256 of each PDF. The rotated text fixture tests that uncertain geometry retains text and reports partial coverage.

Authentic Microsoft Word and Google Docs exports remain follow-up coverage. Keep the source documents, application versions, fonts, file hashes, and independently authored expectations for those exports.

These fixtures cover PDF import and ATS reading. A04 and A05 retain their independent export gates.
