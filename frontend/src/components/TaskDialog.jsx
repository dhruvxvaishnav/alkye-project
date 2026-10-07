import { useState } from 'react'
import { post } from '../api'
import Modal from './Modal'
import Icon from './Icon'
export default function TaskDialog({ token, onClose, onCreated }) {
  const [form,setForm] = useState({title:'',description:'',priority:'medium',due_date:''})
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false)
  const field = (key) => ({value:form[key],onChange:e=>setForm({...form,[key]:e.target.value})})
  async function submit(e) { e.preventDefault();setBusy(true);setError(''); try {await post('/tasks',form,token);onCreated()} catch(e){setError(e.message)} finally {setBusy(false)} }
  return <Modal title="Create a new task" subtitle="Give your team a clear next step." onClose={onClose}><form className="stack" onSubmit={submit}><label>Task title<input autoFocus placeholder="What needs to be done?" required maxLength={200} {...field('title')}/></label><label>Description <span className="optional">(optional)</span><textarea rows={4} placeholder="Add a little context for your team…" {...field('description')}/></label><div className="form-row"><label>Priority<select {...field('priority')}><option value="low">Low priority</option><option value="medium">Medium priority</option><option value="high">High priority</option></select></label><label>Due date<input type="date" {...field('due_date')}/></label></div>{error && <div className="notice error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}><Icon name="plus" size={17}/>{busy?'Creating…':'Create task'}</button></div></form></Modal>
}
