// Groups shown in the "What Folio reads" panel. Which of these actually work is
// decided by the Rust side (engine_status), so this list is presentation only.
export const formatGroups: { label: string; note: string; exts: string[]; office?: boolean }[] = [
  { label: 'Images', note: 'One page per image. Transparent areas become white.', exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'tga', 'qoi'] },
  { label: 'Text & code', note: 'Set in monospace so columns and indents stay put.', exts: ['txt', 'log', 'json', 'xml', 'yaml', 'toml', 'ini', 'py', 'js', 'ts', 'rs', 'go', 'java', 'c', 'cpp', 'sql', 'sh', 'css'] },
  { label: 'Markdown & HTML', note: 'Headings, lists, quotes, code blocks and tables.', exts: ['md', 'markdown', 'html', 'htm'] },
  { label: 'Tables', note: 'Framed tables; wide sheets go landscape on Auto.', exts: ['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'ods'] },
  { label: 'Word', note: 'Text, headings, lists and tables built in. LibreOffice keeps the exact layout.', exts: ['docx'] },
  { label: 'Office via LibreOffice', note: 'Needs LibreOffice installed on this computer.', exts: ['doc', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'odg', 'pages', 'key', 'numbers', 'svg', 'vsdx'], office: true },
];
