import { useState } from 'react'
import { post } from '../api'
import Modal from './Modal'
import Icon from './Icon'

export default function UserDialog({ token, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const field = key => ({
    value: form[key],
    onChange: event => setForm(current => ({ ...current, [key]: event.target.value })),
  })

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await post('/users', form, token)
      onCreated(result.user)
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Create a user" subtitle="Add a new staff member to your workspace." onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>Username<input autoFocus autoComplete="off" placeholder="Enter a username" required maxLength={100} {...field('name')} /></label>
        <label>Email address<input type="email" autoComplete="off" placeholder="name@example.com" required {...field('email')} /></label>
        <label>Password<input type="password" autoComplete="new-password" placeholder="At least 8 characters" required minLength={8} {...field('password')} /></label>
        <p className="form-note">The user can sign in with this email and password, then verify their email code.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}><Icon name="plus" size={17} />{busy ? 'Creating…' : 'Create user'}</button>
        </div>
      </form>
    </Modal>
  )
}
