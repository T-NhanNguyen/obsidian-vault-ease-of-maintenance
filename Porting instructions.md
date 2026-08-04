## Important Notices
When porting the codebase from python over to typescript, emphasize on the following code during the refactor:                                                                                     
1. Brute-force cosine similarity (db.search_similar / _cosine_similarity in db.py) — loads all section embeddings and does a           
pure-Python float loop. Real scale: ~47 files → roughly 150–400 sections × 1024 dims ≈ a few hundred thousand multiply-adds per     
query. That's single-digit milliseconds in a Float64Array loop in Node — JavaScript's TypedArrays are built for exactly this, and   
V8 auto-vectorizes them.                                                                                                            
2. SQLite — better-sqlite3 is a native C binding, as fast as Python's sqlite3 (also C). No gap.                                        
3. Chunking / entity extraction — regex and string ops, a JS-native strength.                                                          
4. Embeddings themselves — not in-process in either language. The embedder POSTs text to an HTTP API (your local OMLX server or        
OpenAI) and gets vectors back. The port never computes model math locally.                                                          
5. Token counting — tiktoken is Python/Rust; TS has WASM-backed equivalents (@dqbd/tiktoken) that work identically
The code has been developed and designed with intentions. Do not alter the logic in anyway unless there is a significant room for improved
in which you will raise a flag to be addressed later. Your job is just to port the code into Typescript. Nothing more.

When making a decission in a fork road during the porting, choose the path that portable, optimized, and eloquantly solve the problem over
preserving visual appeals. They can be corrected later

## Existing Tests and Carrying Tests Over
You must carry tests over, but make sure to port it properly.
Use these tests are your only way to test ported code. If there are missing tests that are critical, itterate on the script, else skip over itterating.
Tooling swaps: pytest + pyproject.toml → vitest + vitest.config.ts; conftest.py fixtures → vitest setupFiles; the FakeEmbedder →     
fake_embedder.ts (ported verbatim, so offline vectors stay identical); scripts/test.sh → same wrapper, calls vitest

## What To aAvoid
- Avoid looking at any other directory except for the two mentioned directory; The original report and the new repo where the port to typescript will live.
- Move away from porting Docker into the new repo. This will be a plugin (running inside Obsidian on the user's machine) needs the engine running locally.
Making Docker a hard prerequisite for end users is real friction — they'd have to install and run Docker just to use the plugin.
- Avoid producing the same code from the original database if you could help yourself to just using the `cp` command or other mac cli command to copy program files over.