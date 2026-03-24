export enum BookingState {
  AVAILABLE = 'AVAILABLE',
  LOCKED = 'LOCKED',
  BOOKED = 'BOOKED',
  FAILED = 'FAILED'
}

type EventAction = 'ACQUIRE_LOCK' | 'CONFIRM_BOOKING' | 'ABORT' | 'EXPIRE_LOCK';

export class BookingStateMachine {
  private static transitions: Record<BookingState, Record<EventAction, BookingState | null>> = {
    AVAILABLE: {
      ACQUIRE_LOCK: BookingState.LOCKED,
      CONFIRM_BOOKING: null,
      ABORT: null,
      EXPIRE_LOCK: null
    },
    LOCKED: {
      ACQUIRE_LOCK: null,
      CONFIRM_BOOKING: BookingState.BOOKED,
      ABORT: BookingState.AVAILABLE,
      EXPIRE_LOCK: BookingState.AVAILABLE
    },
    BOOKED: {
      ACQUIRE_LOCK: null,
      CONFIRM_BOOKING: null,
      ABORT: BookingState.FAILED, // Edge case for refunds
      EXPIRE_LOCK: null
    },
    FAILED: {
      ACQUIRE_LOCK: null,
      CONFIRM_BOOKING: null,
      ABORT: null,
      EXPIRE_LOCK: null
    }
  };

  static transition(currentState: BookingState, action: EventAction): BookingState {
    const nextState = this.transitions[currentState][action];
    if (!nextState) {
      throw new Error(`Invalid state transition: Cannot perform ${action} from ${currentState}`);
    }
    return nextState;
  }
}
