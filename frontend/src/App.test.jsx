import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { request, post } from './api'
import App from './App'

vi.mock('./api', () => ({ request: vi.fn(), post: vi.fn() }))
const admin = { token: 'admin-jwt', user: { id: 1, name: 'Admin', email: 'admin@example.com', role: 'admin' } }
const bond = { token: 'bond-jwt', user: { id: 2, name: 'James Bond', email: 'jamesbond@example.com', role: 'staff' } }
const task = (id, title, assignee_id = 2) => ({ id, title, description: 'API-provided description', status: 'todo', priority: 'medium', assignee_id, assignee_name: assignee_id ? 'James Bond' : null, due_date: '' })
const rows = [task(11, 'API task Alpha'), task(12, 'API task Beta'), task(13, 'API task Gamma')]

function setup(session = bond, data = rows) {
  sessionStorage.setItem('workspace-session', JSON.stringify(session))
  request.mockImplementation(async path => {
    if (path === '/users') return { users: [admin.user, bond.user] }
    if (path === '/tasks' || path === '/tasks/view-my-tasks') return { tasks: data, cache: { hit: false, ttl_seconds: 60 } }
    throw new Error(`Unexpected API request: ${path}`)
  })
  render(<App />)
  return userEvent.setup()
}

async function loaded() { await screen.findByText('API task Alpha') }

describe('task workspace', () => {
  it('renders exactly the three assigned tasks returned by the staff API', async () => {
    setup()
    await loaded()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4)
    for (const row of rows) expect(screen.getByText(row.title)).toBeVisible()
    expect(request).toHaveBeenCalledWith('/tasks/view-my-tasks', { token: 'bond-jwt' })
    expect(request).not.toHaveBeenCalledWith('/tasks', expect.anything())
    expect(screen.getByText(/Synced from database/)).toBeVisible()
  })

  it('shows the actual API 403 as a snackbar without opening the task form', async () => {
    const user = setup()
    await loaded()
    post.mockRejectedValue(Object.assign(new Error('The task creation rights are reserved for admins'), { status: 403 }))
    await user.click(screen.getByRole('button', { name: 'Create task', exact: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent('403 Forbidden')
    expect(screen.getByRole('alert')).toHaveTextContent('The task creation rights are reserved for admins')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(post).toHaveBeenCalledWith('/tasks', { title: '', priority: 'medium' }, 'bond-jwt')
  })

  it('shows cache-hit metadata when refreshing the assigned tasks', async () => {
    const user = setup()
    await loaded()
    request.mockResolvedValueOnce({ tasks: rows, cache: { hit: true, ttl_seconds: 60 } })
    await user.click(screen.getByRole('button', { name: 'Refresh', exact: true }))
    expect(await screen.findByText(/Loaded from cache/)).toBeVisible()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4)
  })

  it('restricts Create task and Refresh to the Tasks page', async () => {
    const user = setup(admin)
    await loaded()
    for (const page of ['Overview', 'Team members', 'Access & security']) {
      await user.click(screen.getByRole('button', { name: page, exact: true }))
      expect(screen.queryByRole('button', { name: 'Create task', exact: true })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Refresh', exact: true })).not.toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: /^Tasks/ }))
    expect(screen.getByRole('button', { name: 'Create task', exact: true })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible()
  })

  it('hides James from assignment when every selected task already belongs to him', async () => {
    const user = setup(admin)
    await loaded()
    await user.click(screen.getByRole('checkbox', { name: 'Select API task Alpha' }))
    await user.click(screen.getByRole('button', { name: 'Assign tasks', exact: true }))
    expect(screen.queryByRole('option', { name: /James Bond/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign selected tasks' })).toBeDisabled()
    expect(screen.getByText(/selected tasks are already assigned/)).toBeVisible()
  })

  it('assigns only tasks James does not already own in mixed selections', async () => {
    const user = setup(admin, [rows[0], task(14, 'API unassigned task', null)])
    await loaded()
    await user.click(screen.getByRole('checkbox', { name: 'Select all visible tasks' }))
    await user.click(screen.getByRole('button', { name: 'Assign tasks', exact: true }))
    expect(screen.getByRole('option', { name: /James Bond/ })).toBeInTheDocument()
    post.mockResolvedValue({ message: 'Tasks assigned successfully.' })
    await user.click(screen.getByRole('button', { name: 'Assign selected tasks' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/assign', { task_ids: [14], user_id: 2 }, 'admin-jwt'))
  })

  it('updates an assigned task status through Rust and renders the returned status', async () => {
    const user = setup()
    await loaded()
    request.mockResolvedValueOnce({ task: { id: 11, status: 'completed' }, message: 'Task status updated successfully.' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status for API task Alpha' }), 'completed')
    expect(request).toHaveBeenCalledWith('/tasks/11/status', {
      method: 'PATCH', body: JSON.stringify({ status: 'completed' }), token: 'bond-jwt',
    })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Status for API task Alpha' })).toHaveValue('completed'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Task status updated successfully.')
  })

  it('keeps the previous status and displays an error when saving fails', async () => {
    const user = setup()
    await loaded()
    request.mockRejectedValueOnce(Object.assign(new Error('You can only update tasks assigned to you.'), { status: 403 }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status for API task Alpha' }), 'completed')
    expect(await screen.findByRole('alert')).toHaveTextContent('You can only update tasks assigned to you.')
    expect(screen.getByRole('combobox', { name: 'Status for API task Alpha' })).toHaveValue('todo')
  })

  it('shows saved staff statuses to admin without staff editing controls', async () => {
    setup(admin, [{ ...rows[0], status: 'in-progress' }, { ...rows[1], status: 'completed' }])
    await loaded()
    const table = within(screen.getByRole('table'))
    expect(table.getByText('In progress')).toBeVisible()
    expect(table.getByText('Completed')).toBeVisible()
    expect(screen.queryByRole('combobox', { name: 'Status for API task Alpha' })).not.toBeInTheDocument()
  })

  it('clears expired sessions and provides an empty state for accounts without tasks', async () => {
    setup(bond, [])
    expect(await screen.findByText('You’re all caught up')).toBeVisible()
    request.mockRejectedValueOnce(Object.assign(new Error('Your session expired. Please sign in again.'), { status: 401 }))
    await act(async () => screen.getByRole('button', { name: 'Refresh', exact: true }).click())
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session expired.')
    expect(sessionStorage.getItem('workspace-session')).toBeNull()
    expect(screen.getByText('A fresh start for great work')).toBeVisible()
  })
})
