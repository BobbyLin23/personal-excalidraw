ALTER TABLE drawings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drawings ADD COLUMN object_key TEXT;
ALTER TABLE drawings ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
UPDATE drawings SET object_key = 'drawings/' || id || '.excalidraw';
