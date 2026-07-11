import React from 'react';
import { formatPrimitive, isJsonLinesLanguage, summarizeJsonEntry } from './json-block.js';

interface JsonViewerProps {
  value: unknown;
  lang: string;
}

interface JsonNodeProps {
  name?: string;
  value: unknown;
  depth?: number;
  index?: number;
  jsonLines?: boolean;
}

function JsonNode({ name, value, depth = 0, index, jsonLines = false }: JsonNodeProps) {
  const label = name ?? (index !== undefined ? String(index) : undefined);

  if (value === null || typeof value !== 'object') {
    return (
      <div className="jsonRow jsonPrimitive">
        {label !== undefined && <span className="jsonKey">{label}: </span>}
        <span className={`jsonValue json-${value === null ? 'null' : typeof value}`}>{formatPrimitive(value)}</span>
      </div>
    );
  }

  if (Array.isArray(value)) {
    const openByDefault = depth === 0 && value.length <= 3;
    return (
      <details className="jsonNode" open={openByDefault}>
        <summary className="jsonSummary">
          {label !== undefined && <span className="jsonKey">{label}: </span>}
          <span className="jsonMeta">Array({value.length})</span>
        </summary>
        <div className="jsonChildren">
          {value.map((item, i) => (
            <JsonNode
              key={i}
              name={jsonLines ? summarizeJsonEntry(item, i) : String(i)}
              value={item}
              depth={depth + 1}
              index={i}
              jsonLines={jsonLines}
            />
          ))}
        </div>
      </details>
    );
  }

  const keys = Object.keys(value as Record<string, unknown>);
  const openByDefault = depth < 2;
  return (
    <details className="jsonNode" open={openByDefault}>
      <summary className="jsonSummary">
        {label !== undefined && <span className="jsonKey">{label}: </span>}
        <span className="jsonMeta">{`{${keys.length} keys}`}</span>
      </summary>
      <div className="jsonChildren">
        {keys.map((key) => (
          <JsonNode
            key={key}
            name={key}
            value={(value as Record<string, unknown>)[key]}
            depth={depth + 1}
            jsonLines={jsonLines}
          />
        ))}
      </div>
    </details>
  );
}

export function JsonViewer({ value, lang }: JsonViewerProps) {
  const jsonLines = isJsonLinesLanguage(lang);
  return (
    <div className="jsonViewer" data-lang={lang}>
      <JsonNode value={value} jsonLines={jsonLines} />
    </div>
  );
}
