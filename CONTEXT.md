# Tesla Charger

Intelligently charges an electric vehicle using excess solar production. Monitors live power data (solar, grid, battery), determines how much excess power is available, and adjusts the vehicle's charging amperage dynamically to consume surplus solar instead of exporting it to the grid.

## Language

### Charging

**Charging Session**:
A continuous period of charge control from session start until the app shuts down.
_Avoid_: app lifecycle, run

**Charging Control State**:
The current position in the 5-state charge-control state machine: Idle, Starting, Charging, ChangingAmpere, or Stopping. Drives which commands the vehicle receives and how long to wait between transitions.
_Avoid_: status, phase

**Target Ampere**:
The charging speed the controller wants the vehicle to run at, calculated from available excess solar. Capped at 32A. Must be >= 3A to start or continue charging (below 3A triggers a stop).
_Avoid_: desired speed, setpoint

**Ramp-Up**:
The time the vehicle takes to physically reach a new ampere after a charge-start or ampere-change command (roughly 1-2 seconds per ampere). The system waits for this period before acting again. During the wait it also monitors for **Grid Import** — a solar production drop during ramp-up means the increase must be reverted.
_Avoid_: cooldown, delay

### Vehicle

**Electric Vehicle**:
The physical car being charged. The system communicates with it through three commands: start charging, stop charging, and set ampere.
_Avoid_: car, Tesla

**Battery State**:
The vehicle's current battery level and charge limit (target SoC), refreshed periodically during active charging. Used to detect when the vehicle has reached its charge target.
_Avoid_: SoC, battery

### Power

**Power Data**:
Live readings from the inverter/grid monitor captured every sync interval. The seven tracked fields are: voltage, current production, current load, daily import, export to grid, import from grid, and battery power. Each field is a watt (W) or volt (V) measurement.
_Avoid_: metrics, sensor data

**Excess Solar**:
Power available for charging after subtracting house load and buffer power from solar production. Accounts for whether the home battery is charging or discharging when calculating net export.
_Avoid_: surplus, spare power

**Buffer Power**:
A safety margin (in watts) subtracted from excess solar before determining charging speed. Prevents over-eager charging when solar production is barely above load. Some controllers use a fixed buffer; weather-aware controllers adjust it dynamically.
_Avoid_: offset, margin, cushion

**Grid Import**:
Power drawn from the grid because solar production fell short of total demand. Detected during ramp-up, grid import triggers a production-guard error that resets the charge attempt.
_Avoid_: importing, importingFromGrid

**Feed-In Limit**:
The maximum power (in watts) the household is allowed to export to the grid. In the feed-in controller, only power above this threshold is considered available for charging.
_Avoid_: max export, export cap

### Forecast

**Solar Forecast**:
A prediction of solar production over future time periods, fetched from Solcast. Includes a base estimate plus 10th and 90th percentile estimates for each period.
_Avoid_: solcast, weather data

**Weather-Aware Buffer**:
A dynamically calculated buffer power that scales based on forecast confidence. When the forecast is confident (actual production matches expectation), the buffer shrinks. When the forecast is uncertain, the buffer grows to protect against grid import.
_Avoid_: dynamic buffer, forecast-adjusted

**Charge Simulation**:
A forward-looking calculation that estimates whether the vehicle can finish charging before sunset given the solar forecast and vehicle battery capacity. Informs the weather-aware controller whether to be more aggressive.
_Avoid_: feasibility check, completion check

## Relationships

- A **Charging Session** has one **Charging Control State** and produces one **Session Summary**.
- A **Charging Control State** transitions through its five states based on the **Target Ampere** calculated each sync cycle.
- **Target Ampere** is derived from **Excess Solar** via one of several controller strategies.
- **Excess Solar** is calculated from **Power Data** minus **Buffer Power**.
- **Buffer Power** is either fixed or determined by the **Weather-Aware Buffer**, which uses the **Solar Forecast** and **Charge Simulation**.
- An **Electric Vehicle** receives start, stop, and set-ampere commands. The system uses **Battery State** to detect charge completion.
- During **Ramp-Up**, the system monitors **Power Data** for **Grid Import**. Detecting import aborts the attempt and retries.

## Example dialogue

> **Dev:** "If a cloud briefly dips **Excess Solar** below the 3A threshold, won't the system stop and restart the vehicle every few seconds?"
> **Domain expert:** "No. The stop command is sent right away, but the **Charging Control State** then stays in Stopping for the full wait period. While in Stopping, any new start request is a no-op. So a 5-second cloud pass won't cause jitter — the system won't re-enter Idle until the wait expires, at which point it re-evaluates from a clean slate."
>
> **Dev:** "What happens if **Grid Import** is detected during **Ramp-Up**?"
> **Domain expert:** "The charge attempt is aborted and retried up to 10 times. This handles brief cloud cover. After 10 consecutive failures, the app dies — something deeper is wrong."
>
> **Dev:** "The **Weather-Aware Buffer** adjusts dynamically — what if the **Solar Forecast** is unavailable?"
> **Domain expert:** "The controller falls back to the default daily production estimate. The **Charge Simulation** can't confirm completion with high confidence in that case, so the system stays conservative."

## Flagged ambiguities

- "charging speed" is used colloquially in code but maps to **Target Ampere** in the domain. Ampere, not wattage, is the unit of speed.
- "battery" is overloaded: the codebases distinguishes **Battery State** (vehicle battery) from battery_power in **Power Data** (home storage battery). In conversation, always clarify which battery.
