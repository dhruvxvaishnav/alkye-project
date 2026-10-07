import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { post } from '../api'
import UserDialog from './UserDialog'

vi.mock('../api', () => ({ post: vi.fn() }))
async function fillForm(user) {
  await user.type(screen.getByLabelText('Username'), 'New Staff')
  await user.type(screen.getByLabelText('Email address'), 'new@example.com')
  await user.type(screen.getByLabelText('Password'), 'NewPassword123!')
}

describe('admin user creation', () => {
  it('creates a staff account using the admin JWT and the API response', async () => {
    const user = userEvent.setup()
    const created = { id: 9, name: 'New Staff', email: 'new@example.com', role: 'staff' }
    const onCreated = vi.fn()
    post.mockResolvedValue({ user: created })
    render(<UserDialog token="admin-jwt" onClose={vi.fn()} onCreated={onCreated} />)
    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Create user' }))
    expect(post).toHaveBeenCalledWith('/users', { name: 'New Staff', email: 'new@example.com', password: 'NewPassword123!' }, 'admin-jwt')
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
  })

  it('shows duplicate-email errors without reporting success', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    post.mockRejectedValue(new Error('This email is already registered.'))
    render(<UserDialog token="admin-jwt" onClose={vi.fn()} onCreated={onCreated} />)
    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Create user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This email is already registered.')
    expect(onCreated).not.toHaveBeenCalled()
  })
})
