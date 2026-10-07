import { useEffect } from 'react'
import Icon from './Icon'

export default function Snackbar({ notification, onClose }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 6000)
    return () => window.clearTimeout(timer)
  }, [notification, onClose])

  return (
    <div className="snackbar" role="alert">
      <Icon name="shield" size={21} />
      <div>
        {notification.status === 403 && <strong>403 Forbidden</strong>}
        <p>{notification.message}</p>
      </div>
      <button className="icon-button" onClick={onClose} aria-label="Dismiss snackbar">
        <Icon name="close" size={18} />
      </button>
    </div>
  )
}
