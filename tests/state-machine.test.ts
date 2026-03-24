import { BookingStateMachine, BookingState } from '../src/lib/state-machine';

describe('Booking State Machine', () => {
  test('should transition from AVAILABLE to LOCKED when acquiring lock', () => {
    const nextState = BookingStateMachine.transition(BookingState.AVAILABLE, 'ACQUIRE_LOCK');
    expect(nextState).toBe(BookingState.LOCKED);
  });

  test('should transition from LOCKED to BOOKED when confirming booking', () => {
    const nextState = BookingStateMachine.transition(BookingState.LOCKED, 'CONFIRM_BOOKING');
    expect(nextState).toBe(BookingState.BOOKED);
  });

  test('should transition from LOCKED to AVAILABLE on abort', () => {
    const nextState = BookingStateMachine.transition(BookingState.LOCKED, 'ABORT');
    expect(nextState).toBe(BookingState.AVAILABLE);
  });

  test('should throw error for invalid transitions', () => {
    // Cannot confirm a booking if it's currently AVAILABLE (must be LOCKED first)
    expect(() => {
      BookingStateMachine.transition(BookingState.AVAILABLE, 'CONFIRM_BOOKING');
    }).toThrow('Invalid state transition: Cannot perform CONFIRM_BOOKING from AVAILABLE');
  });

  test('should transition from BOOKED to FAILED on abort', () => {
    const nextState = BookingStateMachine.transition(BookingState.BOOKED, 'ABORT');
    expect(nextState).toBe(BookingState.FAILED);
  });
});
