import { useState } from "react";
import type { Area, Task, TaskPriority, TaskStatus } from "../../types";
import { attachPastedImage, createTask, updateTask } from "../../lib/api";
import {
  Button,
  Field,
  Segmented,
  Select,
  Sheet,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TextArea,
  TextInput,
  errMsg,
} from "../ui";

export default function TaskForm({
  projectId,
  areas,
  existing,
  onClose,
  onSaved,
}: {
  projectId: number;
  areas: Area[];
  existing?: Task;
  onClose: () => void;
  onSaved: (task: Task) => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(existing?.status ?? "To Do");
  const [priority, setPriority] = useState<TaskPriority>(existing?.priority ?? "Medium");
  const [areaId, setAreaId] = useState<number>(existing?.area_id ?? 0);
  const [prefix, setPrefix] = useState(existing?.prefix ?? "");
  const [cost, setCost] = useState(existing?.cost != null ? String(existing.cost) : "");
  const [currency, setCurrency] = useState(existing?.currency ?? "");
  const [deadline, setDeadline] = useState(existing?.deadline ? existing.deadline.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const costNum = cost.trim() && !Number.isNaN(Number(cost)) ? Number(cost) : undefined;
    const deadlineIso = deadline ? new Date(deadline + "T00:00:00Z").toISOString() : undefined;
    try {
      const saved = existing
        ? await updateTask(existing.id, {
            title: title.trim(),
            description,
            status,
            priority,
            // A cleared field saves as cleared (null); a cost that isn't a number keeps the old one.
            area_id: areaId || null,
            prefix,
            cost: cost.trim() ? costNum : null,
            currency,
            deadline: deadlineIso ?? null,
          })
        : await createTask({
            project_id: projectId,
            title: title.trim(),
            description: description || undefined,
            status,
            priority,
            area_id: areaId || undefined,
            prefix: prefix || undefined,
            cost: costNum,
            currency: currency || undefined,
            deadline: deadlineIso,
          });
      onSaved(saved);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  // Paste an image into the description (existing tasks only — a new task has no
  // id to attach to yet). Uploads as a shared file and embeds /files/<id>.
  const pasteImageIntoDescription = async (clipboard: DataTransfer) => {
    if (!existing) return;
    const item = Array.from(clipboard.items).find((i) => i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    try {
      const att = await attachPastedImage(existing.id, file);
      setDescription((d) => `${d}${d && !d.endsWith("\n") ? "\n" : ""}![image](/files/${att.id})\n`);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const areaOptions = [{ value: 0, label: "No area" }, ...areas.map((a) => ({ value: a.id, label: a.name }))];

  return (
    <Sheet
      title={existing ? "Edit task" : "New task"}
      onClose={onClose}
      footer={
        <Button full onClick={save} disabled={busy || !title.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <Field label="Title">
        <TextInput value={title} onChange={setTitle} autoFocus />
      </Field>
      <Field label="Description">
        <TextArea
          value={description}
          onChange={setDescription}
          placeholder={existing ? "Markdown supported — paste an image to embed it" : "Markdown supported"}
          onPaste={(e: { clipboardData: DataTransfer; preventDefault: () => void }) => {
            const items = Array.from(e.clipboardData.items as DataTransferItemList);
            if (existing && items.some((i) => i.type.startsWith("image/"))) {
              e.preventDefault();
              pasteImageIntoDescription(e.clipboardData);
            }
          }}
        />
      </Field>
      <Field label="Status">
        <Segmented options={TASK_STATUSES} value={status} onChange={setStatus} columns={2} />
      </Field>
      <Field label="Priority">
        <Segmented options={TASK_PRIORITIES} value={priority} onChange={setPriority} columns={3} />
      </Field>
      {areas.length > 0 && (
        <Field label="Area">
          <Select value={areaId} options={areaOptions} onChange={setAreaId} />
        </Field>
      )}
      <Field label="Prefix">
        <TextInput value={prefix} onChange={setPrefix} placeholder="e.g. BUG" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cost">
          <TextInput value={cost} onChange={setCost} inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field label="Currency">
          <TextInput value={currency} onChange={setCurrency} placeholder="USD" />
        </Field>
      </div>
      <Field label="Deadline">
        <TextInput value={deadline} onChange={setDeadline} type="date" />
      </Field>
      {error && <p className="text-sm text-error">{error}</p>}
    </Sheet>
  );
}
