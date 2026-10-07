import { useState } from 'react'
import { post, request } from '../api'
import Modal from './Modal'
import Icon from './Icon'

export default function AuthDialog({ onClose, onLogin }) {
  const [challenge, setChallenge] = useState(null)
  const [email, setEmail] = useState('admin@example.com')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingCode, setLoadingCode] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (challenge) {
        onLogin(await post('/auth/verify-2fa', { login_challenge_id: challenge, code }))
      } else {
        const result = await post('/auth/login', { email, password })
        setCode('')
        setChallenge(result.login_challenge_id)
      }
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function retrieveCode() {
    setLoadingCode(true)
    setError('')
    try {
      const result = await request(`/dev/email-logs/latest?login_challenge_id=${encodeURIComponent(challenge)}`, { cache: 'no-store' })
      setCode(result.code)
    } catch (error) {
      setError(error.message)
    } finally {
      setLoadingCode(false)
    }
  }

  return (
    <Modal title={challenge ? 'Check your inbox' : 'Welcome back'} subtitle={challenge ? `Enter the verification code for ${email}.` : 'Sign in to your workspace to get things moving.'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {challenge ? <>
          <div className="auth-emblem"><Icon name="mail" size={28} /></div>
          <label>Verification code<input autoFocus inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="000000" className="code-input" value={code} onChange={event => setCode(event.target.value)} required /></label>
          <p className="form-note">For local development, retrieve your code below or read the API console. Codes expire after 5 minutes and can only be used once.</p>
          <button type="button" className="secondary" disabled={busy || loadingCode} onClick={retrieveCode}><Icon name="mail" size={16} />{loadingCode ? 'Retrieving…' : 'Get local verification code'}</button>
        </> : <>
          <label>Email address<input type="email" autoFocus value={email} onChange={event => setEmail(event.target.value)} required /></label>
          <label>Password<input type="password" placeholder="Enter your password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
          <div className="form-note secure-note"><Icon name="shield" size={16} />Your account is protected with two-step verification.</div>
        </>}
        {error && <div className="notice error" role="alert">{error}</div>}
        <button className="primary wide" disabled={busy || loadingCode}>{busy ? 'Please wait…' : challenge ? 'Verify & sign in' : 'Continue with email'}<Icon name="arrow" size={17} /></button>
        {challenge && <button type="button" className="text-button" disabled={busy || loadingCode} onClick={() => { setChallenge(null); setCode(''); setError('') }}>Back to sign in</button>}
      </form>
    </Modal>
  )
}
