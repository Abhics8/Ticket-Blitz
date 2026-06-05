import { useEffect, useState } from 'react';
import io from 'socket.io-client';
import Visualizer from './components/Visualizer';
import './App.css';

// Connect to API Server
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const socket = io(API_URL);

type SeatStatus = 'AVAILABLE' | 'BOOKED' | 'LOCKED' | 'PENDING';

interface Seat {
  id: number;
  status: SeatStatus;
}

function App() {
  const [seats, setSeats] = useState<Seat[]>(
    Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: 'AVAILABLE' }))
  );
  const [metrics, setMetrics] = useState({ booked: 0, available: 100 });
  const [telemetry, setTelemetry] = useState({
    locksAcquired: 0,
    kafkaEvents: 0,
    dbWrites: 0,
    lastActionType: 'DB' as 'LOCK' | 'KAFKA' | 'DB',
    lastActionMessage: 'System Ready',
  });

  const setSeatStatus = (id: number, status: SeatStatus) =>
    setSeats((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)));

  // Initial sync + live updates from OTHER clients (via the server's socket push).
  useEffect(() => {
    const fetchSeats = async () => {
      try {
        const res = await fetch(`${API_URL}/api/seats`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        setSeats(data.map((s: any) => ({ id: s.number, status: s.status as SeatStatus })));
        setTelemetry((p) => ({ ...p, lastActionMessage: 'System Synchronized' }));
      } catch {
        setTelemetry((p) => ({
          ...p,
          lastActionType: 'LOCK',
          lastActionMessage: 'Backend offline — start/redeploy the API',
        }));
      }
    };
    fetchSeats();

    const onUpdate = (data: { seatNumber: number; status: SeatStatus }) => {
      setSeats((prev) =>
        prev.map((seat) => (seat.id === data.seatNumber ? { ...seat, status: data.status } : seat))
      );
      setTelemetry((p) => ({
        ...p,
        kafkaEvents: p.kafkaEvents + 1,
        lastActionType: 'KAFKA',
        lastActionMessage: `Live update: Seat ${data.seatNumber} → ${data.status}`,
      }));
    };

    socket.on('seat-update', onUpdate);
    return () => {
      socket.off('seat-update', onUpdate);
    };
  }, []);

  useEffect(() => {
    const booked = seats.filter((s) => s.status === 'BOOKED').length;
    setMetrics({ booked, available: seats.length - booked });
  }, [seats]);

  const handleSeatClick = async (seat: Seat) => {
    if (seat.status !== 'AVAILABLE') return;

    // Optimistic pending state
    setSeatStatus(seat.id, 'PENDING');
    setTelemetry((p) => ({ ...p, lastActionType: 'LOCK', lastActionMessage: `Acquiring lock: Seat ${seat.id}` }));

    try {
      const res = await fetch(`${API_URL}/api/book`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `seat-${seat.id}-${Date.now()}`,
        },
        body: JSON.stringify({
          userId: `demo_user_${Math.floor(Math.random() * 100000)}`,
          seatNumber: seat.id,
        }),
      });

      if (res.ok) {
        // Confirmed by the server (HTTP 200) — update immediately. The socket
        // event will also arrive (idempotent), keeping other clients in sync.
        setSeatStatus(seat.id, 'BOOKED');
        setTelemetry((p) => ({
          ...p,
          locksAcquired: p.locksAcquired + 1,
          dbWrites: p.dbWrites + 1,
          lastActionType: 'DB',
          lastActionMessage: `Booked Seat ${seat.id}`,
        }));
      } else if (res.status === 409) {
        // Lost the race — someone else got it first.
        setSeatStatus(seat.id, 'BOOKED');
        setTelemetry((p) => ({
          ...p,
          locksAcquired: p.locksAcquired + 1,
          lastActionType: 'LOCK',
          lastActionMessage: `Seat ${seat.id} already taken`,
        }));
      } else {
        setSeatStatus(seat.id, 'AVAILABLE');
        setTelemetry((p) => ({ ...p, lastActionMessage: `Booking failed (HTTP ${res.status})` }));
      }
    } catch {
      // Network error = backend unreachable. Make that obvious, don't fail silently.
      setSeatStatus(seat.id, 'AVAILABLE');
      setTelemetry((p) => ({
        ...p,
        lastActionType: 'LOCK',
        lastActionMessage: 'Backend unreachable — is the API awake?',
      }));
    }
  };

  return (
    <div className="container">
      <h1>TicketBlitz Live ⚡</h1>

      <div className="metrics">
        <div className="card">
          <h3>Available</h3>
          <span className="green">{metrics.available}</span>
        </div>
        <div className="card">
          <h3>Sold Out</h3>
          <span className="red">{metrics.booked}</span>
        </div>
      </div>

      <div className="grid">
        {seats.map((seat) => (
          <div
            key={seat.id}
            onClick={() => handleSeatClick(seat)}
            className={`seat ${seat.status.toLowerCase()}`}
            title={`Seat ${seat.id}`}
          >
            {seat.status === 'PENDING' ? '...' : seat.id}
          </div>
        ))}
      </div>

      <Visualizer metrics={telemetry} />

      <p style={{ marginTop: '2rem', color: '#666', fontSize: '0.8rem' }}>
        Backend: Node.js + Fastify + Redis + Postgres | Frontend: React + Socket.io
      </p>
    </div>
  );
}

export default App;
