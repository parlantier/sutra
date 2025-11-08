#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const glob = require('glob');
const Database = require('better-sqlite3');
const iconv = require('iconv-lite');
const { XMLParser } = require('fast-xml-parser');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const BLOCK_TAGS = new Set(['ab', 'sp', 'q', 'seg']);

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  if (entries.length && Object.prototype.hasOwnProperty.call(entries[0], 'key')) {
    return entries;
  }
  return entries.map((entry) => {
    const pairs = Object.entries(entry);
    if (!pairs.length) {
      return { key: '', value: null };
    }
    const [key, value] = pairs[0];
    return { key, value };
  });
}

function loadKoreanTitleMap(filePath) {
  if (!filePath) {
    return null;
  }
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  Korean title map not found at ${filePath}. Titles will be left empty.`);
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalizeKeys = (input = {}) => {
      const out = {};
      for (const [key, value] of Object.entries(input)) {
        out[key.toLowerCase()] = value;
      }
      return out;
    };
    return {
      xmlId: normalizeKeys(raw.xmlId),
      typeN: normalizeKeys(raw.typeN),
      head: normalizeKeys(raw.head)
    };
  } catch (err) {
    console.warn(`⚠️  Failed to read Korean title map: ${err.message}`);
    return null;
  }
}

function decodeXml(buffer, relPath) {
  const encodings = ['utf16le', 'utf16be'];
  const bom = buffer.slice(0, 2);
  if (bom[0] === 0xfe && bom[1] === 0xff) {
    encodings.unshift('utf16be');
  } else if (bom[0] === 0xff && bom[1] === 0xfe) {
    encodings.unshift('utf16le');
  }
  for (const enc of encodings) {
    try {
      return iconv.decode(buffer, enc);
    } catch (err) {
      // try next encoding
    }
  }
  throw new Error(`Unable to decode XML for ${relPath}. Tried ${encodings.join(', ')}`);
}

function extractTeiHeader(xmlText) {
  const match = xmlText.match(/<teiHeader[\s\S]*?<\/teiHeader>/i);
  return match ? match[0] : null;
}

function applySchema(db, schemaPath) {
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);
}

function createStatements(db) {
  return {
    selectSource: db.prepare('SELECT id FROM source_files WHERE rel_path = ?'),
    insertSource: db.prepare('INSERT INTO source_files (rel_path, sha1, tei_header, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'),
    updateSource: db.prepare('UPDATE source_files SET sha1 = ?, tei_header = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
    deletePosts: db.prepare('DELETE FROM posts WHERE source_file_id = ?'),
    deletePages: db.prepare('DELETE FROM pages WHERE source_file_id = ?'),
    deleteNodes: db.prepare('DELETE FROM nodes WHERE source_file_id = ?'),
    insertNode: db.prepare(`
      INSERT INTO nodes (source_file_id, parent_id, xml_id, type, n, head, head_korean, order_in_parent, depth)
      VALUES (@source_file_id, @parent_id, @xml_id, @type, @n, @head, @head_korean, @order_in_parent, @depth)
    `),
    insertPage: db.prepare(`
      INSERT INTO pages (source_file_id, page_no, xml_id, n, facs)
      VALUES (@source_file_id, @page_no, @xml_id, @n, @facs)
    `),
    insertPost: db.prepare(`
      INSERT INTO posts (source_file_id, node_id, page_id, order_in_file, kind, xml_id, content_pali, content_norm)
      VALUES (@source_file_id, @node_id, @page_id, @order_in_file, @kind, @xml_id, @content_pali, @content_norm)
    `)
  };
}

function parseTagContent(value) {
  const attrs = {};
  const children = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const pairs = Object.entries(entry);
      if (!pairs.length) {
        continue;
      }
      const [key, inner] = pairs[0];
      if (key.startsWith('@_')) {
        const attrName = key.substring(2);
        attrs[attrName] = inner;
      } else {
        children.push({ key, value: inner });
      }
    }
  }
  return { attrs, children };
}

function collectText(entries) {
  if (!entries) {
    return '';
  }
  if (typeof entries === 'string') {
    return entries;
  }
  const normalized = normalizeEntries(entries);
  let result = '';
  for (const entry of normalized) {
    const key = entry.key;
    const value = entry.value;
    if (key === '#text') {
      result += typeof value === 'string' ? value : '';
    } else if (key === 'lb' || key === 'pb') {
      result += '\n';
    } else if (key.startsWith('@_')) {
      continue;
    } else {
      if (Array.isArray(value)) {
        result += collectText(value);
      } else if (value && typeof value === 'object') {
        result += collectText([value]);
      } else if (typeof value === 'string') {
        result += value;
      }
    }
  }
  return result;
}

function normalizeContent(text) {
  if (!text) {
    return null;
  }
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC');
  const lines = normalized.split('\n').map((line) => line.trim().replace(/[\t ]+/g, ' '));
  const collapsed = lines.join('\n').trim();
  return collapsed.length ? collapsed : null;
}

function lookupKoreanTitle(map, attrs, headText) {
  if (!map) {
    return null;
  }
  const xmlId = (attrs['xml:id'] || attrs.xml_id || '').toLowerCase();
  if (xmlId && map.xmlId && map.xmlId[xmlId]) {
    return map.xmlId[xmlId];
  }
  const type = (attrs.type || '').toLowerCase();
  const n = (attrs.n || '').toLowerCase();
  if (type && n && map.typeN) {
    const key = `${type}|${n}`;
    if (map.typeN[key]) {
      return map.typeN[key];
    }
  }
  if (headText && map.head) {
    const normalizedHead = headText.normalize('NFC').toLowerCase();
    if (map.head[normalizedHead]) {
      return map.head[normalizedHead];
    }
  }
  return null;
}

function buildContext(sourceFileId, statements, koreanMap) {
  return {
    sourceFileId,
    statements,
    koreanMap,
    nodeStack: [],
    rootChildCount: 0,
    pageNo: 0,
    currentPageId: null,
    orderInFile: 0,
    pageCount: 0,
    postCount: 0
  };
}

function nextOrderForParent(context) {
  if (!context.nodeStack.length) {
    context.rootChildCount += 1;
    return context.rootChildCount;
  }
  const parent = context.nodeStack[context.nodeStack.length - 1];
  parent.childCount = (parent.childCount || 0) + 1;
  return parent.childCount;
}

function handleParagraph(tagValue, context, tagName = 'p') {
  const { attrs, children } = parseTagContent(tagValue);
  const text = collectText(children).trimEnd();
  if (!text.trim()) {
    return;
  }
  const post = {
    source_file_id: context.sourceFileId,
    node_id: context.nodeStack.length ? context.nodeStack[context.nodeStack.length - 1].id : null,
    page_id: context.currentPageId,
    order_in_file: ++context.orderInFile,
    kind: tagName,
    xml_id: attrs['xml:id'] || attrs.xml_id || null,
    content_pali: text,
    content_norm: normalizeContent(text)
  };
  context.statements.insertPost.run(post);
  context.postCount += 1;
}

function handleLg(tagValue, context) {
  const { attrs, children } = parseTagContent(tagValue);
  const lines = [];
  for (const child of children) {
    if (child.key === 'l') {
      const { children: lineChildren } = parseTagContent(child.value);
      const lineText = collectText(lineChildren).trim();
      if (lineText) {
        lines.push(lineText);
      }
    }
  }
  if (!lines.length) {
    const fallback = collectText(children).trim();
    if (fallback) {
      lines.push(fallback);
    }
  }
  if (!lines.length) {
    return;
  }
  const text = lines.join('\n');
  const post = {
    source_file_id: context.sourceFileId,
    node_id: context.nodeStack.length ? context.nodeStack[context.nodeStack.length - 1].id : null,
    page_id: context.currentPageId,
    order_in_file: ++context.orderInFile,
    kind: 'lg',
    xml_id: attrs['xml:id'] || attrs.xml_id || null,
    content_pali: text,
    content_norm: normalizeContent(text)
  };
  context.statements.insertPost.run(post);
  context.postCount += 1;
}

function handlePb(tagValue, context) {
  const { attrs } = parseTagContent(tagValue);
  context.pageNo += 1;
  const page = {
    source_file_id: context.sourceFileId,
    page_no: context.pageNo,
    xml_id: attrs['xml:id'] || attrs.xml_id || null,
    n: attrs.n || null,
    facs: attrs.facs || null
  };
  const info = context.statements.insertPage.run(page);
  context.currentPageId = info.lastInsertRowid;
  context.pageCount += 1;
}

function handleDiv(tagValue, context) {
  const { attrs, children } = parseTagContent(tagValue);
  const headPieces = [];
  const remaining = [];
  for (const child of children) {
    if (child.key === 'head') {
      const headText = collectText(child.value).trim();
      if (headText) {
        headPieces.push(headText);
      }
    } else {
      remaining.push(child);
    }
  }
  const headText = headPieces.join(' | ') || null;
  const headKorean = lookupKoreanTitle(context.koreanMap, attrs, headText);
  const nodeRecord = {
    source_file_id: context.sourceFileId,
    parent_id: context.nodeStack.length ? context.nodeStack[context.nodeStack.length - 1].id : null,
    xml_id: attrs['xml:id'] || attrs.xml_id || null,
    type: attrs.type || null,
    n: attrs.n || null,
    head: headText,
    head_korean: headKorean,
    order_in_parent: nextOrderForParent(context),
    depth: context.nodeStack.length + 1
  };
  const info = context.statements.insertNode.run(nodeRecord);
  const nodeId = info.lastInsertRowid;
  context.nodeStack.push({ id: nodeId, childCount: 0 });
  processChildren(remaining, context);
  context.nodeStack.pop();
}

function processChildren(children, context) {
  const normalized = normalizeEntries(children);
  for (const child of normalized) {
    const key = child.key;
    const value = child.value;
    if (!key || key.startsWith('@_')) {
      continue;
    }
    if (key === '#text' || key === '#comment') {
      continue;
    }
    if (key === 'pb') {
      handlePb(value, context);
    } else if (key === 'div') {
      handleDiv(value, context);
    } else if (key === 'p') {
      handleParagraph(value, context, 'p');
    } else if (key === 'lg') {
      handleLg(value, context);
    } else if (BLOCK_TAGS.has(key)) {
      handleParagraph(value, context, key);
    } else if (key === 'head') {
      // already processed in handleDiv
      continue;
    } else {
      const { children: nestedChildren } = parseTagContent(value);
      if (nestedChildren.length) {
        processChildren(nestedChildren, context);
      }
    }
  }
}

function extractBody(parsed) {
  const findTag = (nodes, tagName) => {
    if (!Array.isArray(nodes)) {
      return null;
    }
    for (const node of nodes) {
      const entries = Object.entries(node);
      if (!entries.length) {
        continue;
      }
      const [key, value] = entries[0];
      if (key === tagName) {
        return value;
      }
    }
    return null;
  };

  const tei = findTag(parsed, 'TEI');
  if (!tei) {
    return null;
  }
  const text = findTag(tei, 'text');
  if (!text) {
    return null;
  }
  const body = findTag(text, 'body');
  return body || null;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('source', {
      alias: 's',
      demandOption: true,
      describe: 'Path to the root of the tipitaka-xml repository'
    })
    .option('db', {
      alias: 'd',
      default: path.join('db', 'sutra.sqlite'),
      describe: 'Destination SQLite file path'
    })
    .option('schema', {
      default: path.join('schema', 'schema.sql'),
      describe: 'Schema SQL file to initialize the database'
    })
    .option('pattern', {
      alias: 'p',
      default: 'romn/**/*.xml',
      describe: 'Glob pattern (relative to source) for TEI XML files'
    })
    .option('korean-map', {
      alias: 'k',
      default: path.join('data', 'korean_titles.json'),
      describe: 'JSON file that maps identifiers to Korean titles'
    })
    .option('limit', {
      type: 'number',
      describe: 'Process only the first N files (useful for testing)'
    })
    .help()
    .argv;

  const sourceRoot = path.resolve(argv.source);
  const dbPath = path.resolve(argv.db);
  const schemaPath = path.resolve(argv.schema);
  const koreanMapPath = argv['korean-map'] ? path.resolve(argv['korean-map']) : null;

  if (!fs.existsSync(sourceRoot)) {
    console.error(`Source directory not found: ${sourceRoot}`);
    process.exit(1);
  }

  const files = glob.sync(argv.pattern, {
    cwd: sourceRoot,
    nodir: true
  }).sort();

  const limitedFiles = typeof argv.limit === 'number' ? files.slice(0, argv.limit) : files;
  if (!limitedFiles.length) {
    console.warn('No XML files matched the given pattern.');
    return;
  }

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  applySchema(db, schemaPath);
  const statements = createStatements(db);
  const koreanMap = loadKoreanTitleMap(koreanMapPath);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    trimValues: false
  });

  let totalPages = 0;
  let totalPosts = 0;

  for (const relPath of limitedFiles) {
    const absPath = path.join(sourceRoot, relPath);
    const buffer = fs.readFileSync(absPath);
    const xmlText = decodeXml(buffer, relPath);
    const teiHeader = extractTeiHeader(xmlText);
    const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
    const parsed = parser.parse(xmlText);
    const body = extractBody(parsed);
    if (!body) {
      console.warn(`⚠️  Skipping ${relPath}: <text><body> not found.`);
      continue;
    }

    const transaction = db.transaction(() => {
      const existing = statements.selectSource.get(relPath);
      let sourceFileId;
      if (existing) {
        statements.updateSource.run(sha1, teiHeader, existing.id);
        statements.deletePosts.run(existing.id);
        statements.deletePages.run(existing.id);
        statements.deleteNodes.run(existing.id);
        sourceFileId = existing.id;
      } else {
        const info = statements.insertSource.run(relPath, sha1, teiHeader);
        sourceFileId = info.lastInsertRowid;
      }

      const context = buildContext(sourceFileId, statements, koreanMap);
      processChildren(body, context);
      totalPages += context.pageCount;
      totalPosts += context.postCount;
    });

    try {
      transaction();
      console.log(`✔ Processed ${relPath}`);
    } catch (err) {
      console.error(`✖ Failed to process ${relPath}: ${err.message}`);
      throw err;
    }
  }

  console.log(`Completed. Files: ${limitedFiles.length}, Pages: ${totalPages}, Posts: ${totalPosts}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
