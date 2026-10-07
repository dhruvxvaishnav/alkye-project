import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { post, request } from '../api'
import AuthDialog from './AuthDialog'

vi.mock('../api', () => ({ post: vi.fn(), request: vi.fn() }))

async function startLogin(onLogin = vi.fn()) {
  const user = userEvent.setup()
  render(<AuthDialog onClose={vi.fn()} onLogin={onLogin} />)
  await user.type(screen.getByLabelText('Password'), 'Workspace123!')
  await user.click(screen.getByRole('button', { name: 'Continue with email' }))
  return { user, onLogin }
}

describe('two-factor login', () => {
  it('does not authenticate until the email code has been verified', async () => {
    post.mockResolvedValueOnce({ login_challenge_id: 'challenge-123' })
    const session = { token: 'verified-jwt', user: { name: 'Admin', role: 'admin' } }
    post.mockResolvedValueOnce(session)
    request.mockResolvedValue({ code: '123456' })
    const { user, onLogin } = await startLogin()
    expect(await screen.findByLabelText('Verification code')).toBeVisible()
    expect(onLogin).not.toHaveBeenCalled()
    expect(post).toHaveBeenNthCalledWith(1, '/auth/login', { email: 'admin@example.com', password: 'Workspace123!' })
    await user.click(screen.getByRole('button', { name: 'Get local verification code' }))
    expect(request).toHaveBeenCalledWith('/dev/email-logs/latest?login_challenge_id=challenge-123', { cache: 'no-store' })
    await waitFor(() => expect(screen.getByLabelText('Verification code')).toHaveValue('123456'))
    await user.click(screen.getByRole('button', { name: 'Verify & sign in' }))
    expect(post).toHaveBeenNthCalledWith(2, '/auth/verify-2fa', { login_challenge_id: 'challenge-123', code: '123456' })
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(session))
  })

  it('shows verification errors and never authenticates a rejected code', async () => {
    post.mockResolvedValueOnce({ login_challenge_id: 'bad-code-challenge' }).mockRejectedValueOnce(new Error('That verification code is incorrect.'))
    const { user, onLogin } = await startLogin()
    await user.type(await screen.findByLabelText('Verification code'), '999999')
    await user.click(screen.getByRole('button', { name: 'Verify & sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That verification code is incorrect.')
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('disables submission while login is pending', async () => {
    let resolveLogin
    post.mockImplementation(() => new Promise(resolve => { resolveLogin = resolve }))
    const { onLogin } = await startLogin()
    expect(screen.getByRole('button', { name: 'Please wait…' })).toBeDisabled()
    await act(async () => resolveLogin({ login_challenge_id: 'pending-challenge' }))
    expect(await screen.findByLabelText('Verification code')).toBeVisible()
    expect(onLogin).not.toHaveBeenCalled()
  })
})
