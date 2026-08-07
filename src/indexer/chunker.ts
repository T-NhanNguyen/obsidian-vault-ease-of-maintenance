// Markdown chunker — splits files into header sections.
// Ported from src/indexer/chunker.py

import * as crypto from "crypto";

export interface SectionInfo {
  nodeKey: string;
  fileId: string;
  headingPath: string;
  headingText: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  contentHash: string;
  embedding?: number[];
}

export interface FileInfoForChunking {
  path?: string;
  file_id?: string;
  content: string;
}

export class Chunker {
  chunk(fileInfo: FileInfoForChunking): SectionInfo[] {
    const content: string = fileInfo.content || "";
    const fileId: string = fileInfo.path || fileInfo.file_id || "";

    // Strip frontmatter
    const [body] = this.stripFrontmatter(content);

    // Parse into heading-delimited sections
    const sections = this.splitByHeadings(fileId, body);

    // Compute content_hash and line ranges for each section
    const result: SectionInfo[] = [];
    for (const section of sections) {
      const text = section.text.trim();
      if (!text) continue;
      const textHash = crypto.createHash("sha1").update(text).digest("hex");
      result.push({
        nodeKey: section.nodeKey,
        fileId: fileId,
        headingPath: section.headingPath,
        headingText: section.headingText,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        text: text,
        contentHash: textHash,
      });
    }
    return result;
  }

  private stripFrontmatter(content: string): [string, string] {
    const match = content.match(/^---\s*\n(.*?)\n---\s*\n/s);
    if (match) {
      return [content.slice(match[0].length), match[1]];
    }
    return [content, ""];
  }

  private splitByHeadings(fileId: string, body: string): RawSection[] {
    const lines = body.split("\n");
    const sections: RawSection[] = [];
    const headingStack: [number, string, string][] = []; // [level, text, slug]
    let currentLines: string[] = [];
    let currentStart = 0;
    let headingFound = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        // Save current section
        if (headingFound && currentLines.length > 0) {
          sections.push(this.makeSection(fileId, headingStack, currentLines, currentStart));
        }

        const level = headingMatch[1].length;
        const text = headingMatch[2].trim();

        // Trim stack to matching level
        while (headingStack.length > 0 && headingStack[headingStack.length - 1][0] >= level) {
          headingStack.pop();
        }
        headingStack.push([level, text, text.toLowerCase().replace(/ /g, "-")]);

        headingFound = true;
        currentLines = [];
        currentStart = i + 1;
      } else {
        currentLines.push(line);
      }
    }

    // Last section after final heading
    if (currentLines.length > 0) {
      sections.push(this.makeSection(fileId, headingStack, currentLines, currentStart));
    }

    // No headings found — whole body is one root-level section
    // (Python returns line_start: 0 here — NOT 1-indexed)
    if (!headingFound) {
      return [{
        nodeKey: `${fileId}::`,
        fileId,
        headingPath: "",
        headingText: "",
        lineStart: 0,
        lineEnd: lines.length,
        text: body.trim(),
      }];
    }

    return sections;
  }

  private makeSection(
    fileId: string,
    headingStack: [number, string, string][],
    sectionLines: string[],
    lineStart: number,
  ): RawSection {
    const headingPath = headingStack.map(h => h[1]).join(" › ");
    const headingText = headingStack.length > 0 ? headingStack[headingStack.length - 1][1] : "";
    const text = sectionLines.join("\n");
    const lineEnd = lineStart + sectionLines.length;

    // Generate stable node_key
    const nodeKey = headingPath ? `${fileId}::${headingPath}` : `${fileId}::`;

    return {
      nodeKey,
      fileId,
      headingPath,
      headingText,
      lineStart: lineStart + 1, // 1-indexed
      lineEnd,
      text,
    };
  }
}

interface RawSection {
  nodeKey: string;
  fileId: string;
  headingPath: string;
  headingText: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}
