import { useState } from "react";
import type { Project } from "../../types";
import { createProject, updateProject } from "../../lib/api";
import { Button, Field, Sheet, TextArea, TextInput, errMsg } from "../ui";

export default function ProjectForm({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = existing
        ? await updateProject(existing.id, { name: name.trim(), description })
        : await createProject({ name: name.trim(), description: description || undefined });
      onSaved(p);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={existing ? "Edit project" : "New project"}
      onClose={onClose}
      footer={
        <Button full onClick={save} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <Field label="Name">
        <TextInput value={name} onChange={setName} autoFocus />
      </Field>
      <Field label="Description">
        <TextArea value={description} onChange={setDescription} />
      </Field>
      {error && <p className="text-sm text-error">{error}</p>}
    </Sheet>
  );
}
