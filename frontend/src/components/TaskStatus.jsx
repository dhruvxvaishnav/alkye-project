import { useState } from 'react'

const statuses = [
  { value: 'todo', label: 'To do' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
]

export default function TaskStatus({ task, editable, onUpdate }) {
  const [busy, setBusy] = useState(false)

  async function changeStatus(event) {
    const status = event.target.value
    if (status === task.status || busy) return
    setBusy(true)
    try {
      await onUpdate(task.id, status)
    } finally {
      setBusy(false)
    }
  }

  if (!editable) {
    return <span className={`status-pill ${task.status}`}><i />{statuses.find(status => status.value === task.status)?.label || task.status}</span>
  }

  return (
    <div className="status-control">
      <select
        className={`status-pill status-select ${task.status}`}
        aria-label={`Status for ${task.title}`}
        value={task.status}
        disabled={busy}
        onChange={changeStatus}
      >
        {statuses.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}
      </select>
      {busy && <span className="status-saving" role="status">Saving…</span>}
    </div>
  )
}
