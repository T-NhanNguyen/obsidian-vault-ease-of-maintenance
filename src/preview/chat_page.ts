// Chat page renderer — HTML generation for chat queries.
// Ported from src/preview/chat_page.py

export function renderChatPage(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Chat — Vault Ease of Maintenance</title></head>
<body>
  <h1>Vault Search</h1>
  <div class="search-row">
    <input type="text" id="query" placeholder="Ask a question..." autofocus>
    <button onclick="search()">Search</button>
  </div>
  <div id="answer"></div>
  <div id="results"></div>
<script>
async function search() {
  const q = document.getElementById('query').value.trim();
  if (!q) return;
  try {
    const r = await fetch('/chat/query', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({question: q, top_k: 5})
    });
    const data = await r.json();
    document.getElementById('answer').innerHTML = '<h2>Answer</h2><p>' + (data.answer || 'No answer') + '</p>';
    document.getElementById('results').innerHTML = '<h2>Sources</h2>' + (data.results || []).map((s,i) => '<p>[' + (i+1) + '] ' + s.file_path + ': ' + (s.text || '').slice(0,200) + '</p>').join('');
  } catch(e) {
    document.getElementById('answer').innerHTML = '<p style="color:red">Error: ' + e.message + '</p>';
  }
}
</script>
</body></html>`;
}

export interface QueryResult {
  nodeKey: string;
  filePath: string;
  headingPath: string;
  score: number;
  text: string;
  lineStart: number;
  lineEnd: number;
}

// Rows arrive from either the DB (snake_case) or the chat API (camelCase).
export function renderQueryResults(results: Array<Record<string, unknown>>): QueryResult[] {
  return results.map(r => ({
    nodeKey: (r.nodeKey || r.node_key || "") as string,
    filePath: (r.filePath || r.file_path || r.fileId || r.file_id || "") as string,
    headingPath: (r.headingPath || r.heading_path || "") as string,
    score: Number(r.score || 0.0),
    text: (r.text || "") as string,
    lineStart: Number(r.lineStart || r.line_start || 0),
    lineEnd: Number(r.lineEnd || r.line_end || 0),
  }));
}
