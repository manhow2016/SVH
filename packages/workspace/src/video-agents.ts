/**
 * 创建 Workspace 时自动生成的默认指令文件（文档 §26）。
 *
 * Context Builder 会自动读取该文件；若不存在则使用默认 System Prompt。
 */
export const DEFAULT_VIDEO_AGENTS_MD = `# SVH Workspace Instructions

This workspace is used for short video production.

## General Rules

- Inspect existing files before modifying them.
- Prefer updating existing files instead of creating duplicates.
- Keep files organized.
- Use clear file names.
- Do not delete files unless necessary.

## Project Artifacts

Possible project artifacts include:

- script.md
- storyboard.json
- timeline.json
- assets/
- generated/

## Agent Behavior

Explain important workspace changes after completing a task.
`;
