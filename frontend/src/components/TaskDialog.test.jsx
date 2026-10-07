import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { post } from '../api'
import TaskDialog from './TaskDialog'

vi.mock('../api', () => ({ post: vi.fn() }))

describe('admin task creation', () => {
  it('submits the task fields and admin JWT to the API', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    post.mockResolvedValue({ id: 42, message: 'Task created successfully.' })
    render(<TaskDialog token="admin-jwt" onClose={vi.fn()} onCreated={onCreated} />)
    await user.type(screen.getByLabelText('Task title'), 'Plan launch')
    await user.type(screen.getByLabelText(/Description/), 'Prepare launch milestones')
    await user.selectOptions(screen.getByLabelText('Priority'), 'high')
    await user.click(screen.getByRole('button', { name: 'Create task', exact: true }))
    expect(post).toHaveBeenCalledWith('/tasks', {
      title: 'Plan launch', description: 'Prepare launch milestones', priority: 'high', due_date: '',
    }, 'admin-jwt')
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
  })

  it('keeps the form open and reports API failures', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    post.mockRejectedValue(new Error('Unable to save this task.'))
    render(<TaskDialog token="admin-jwt" onClose={vi.fn()} onCreated={onCreated} />)
    await user.type(screen.getByLabelText('Task title'), 'Plan launch')
    await user.click(screen.getByRole('button', { name: 'Create task', exact: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save this task.')
    expect(screen.getByLabelText('Task title')).toHaveValue('Plan launch')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('does not send an empty required task title', async () => {
    const user = userEvent.setup()
    render(<TaskDialog token="admin-jwt" onClose={vi.fn()} onCreated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Create task', exact: true }))
    expect(screen.getByLabelText('Task title')).toBeInvalid()
    expect(post).not.toHaveBeenCalled()
  })
})
