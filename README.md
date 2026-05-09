# SkillsMP Clone

A SkillsMP-inspired local marketplace for Codex/agent skills. Users can publish a skill package, browse the registry, and download uploaded packages through the app.

## Run

```bash
npm start
```

Open `http://localhost:4173`.

## API

- `GET /api/skills` lists uploaded skills.
- `GET /api/skills/:id` returns package file metadata and the parsed `SKILL.md` for the detail page.
- `POST /api/skills` accepts multipart form data with `title`, optional metadata, and a `package` file.
- `GET /api/skills/:id/download` downloads the uploaded package and increments its download count.

The repo ships with one local demo skill in `data/skills.json` and `uploads/demo-skill.zip`. Uploaded files are stored in `uploads/`; registry metadata is stored in `data/skills.json`.
