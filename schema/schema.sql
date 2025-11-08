PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_files (
    id INTEGER PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    sha1 TEXT NOT NULL,
    tei_header TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY,
    source_file_id INTEGER NOT NULL,
    parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    xml_id TEXT,
    type TEXT,
    n TEXT,
    head TEXT,
    head_korean TEXT,
    order_in_parent INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_file_id) REFERENCES source_files(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_source_xml
    ON nodes(source_file_id, xml_id)
    WHERE xml_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY,
    source_file_id INTEGER NOT NULL,
    page_no INTEGER NOT NULL,
    xml_id TEXT,
    n TEXT,
    facs TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_file_id) REFERENCES source_files(id) ON DELETE CASCADE,
    UNIQUE (source_file_id, page_no)
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    source_file_id INTEGER NOT NULL,
    node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
    order_in_file INTEGER NOT NULL,
    kind TEXT NOT NULL,
    xml_id TEXT,
    content_pali TEXT NOT NULL,
    content_norm TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_file_id) REFERENCES source_files(id) ON DELETE CASCADE,
    UNIQUE (source_file_id, order_in_file)
);

CREATE INDEX IF NOT EXISTS idx_posts_source_node
    ON posts(source_file_id, node_id);

CREATE INDEX IF NOT EXISTS idx_posts_page
    ON posts(page_id);
