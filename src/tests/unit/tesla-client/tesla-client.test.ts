//import { Effect } from "effect";
import { describe, it } from "@effect/vitest";

describe("TeslaClient", () => {
  //TODO
  // it.effect("should fetch vehicle data successfully", () => Effect.gen(function* () {

  // }));

  describe("authenticateFromAuthCodeGrant", () => {
    it.todo("should authenticate successfully given valid auth code");
    it.todo("should fail authentication given invalid auth code");
    it.todo("should return error on network connectivity issues");
    it.todo("should return error out when request times out");
    it.todo("should return error for unexpected server responses");
  });

  describe("refreshAccessToken", () => {
    it.todo("should refresh access token successfully given valid refresh token exists");
    it.todo("should fail to refresh access token given invalid refresh token");
    it.todo("should return retry with exponential backoff on network connectivity issues");
    it.todo("should return retry with exponential backoff when request times out");
    it.todo("should return retry with exponential backoff when server returns 5xx errors");
    it.todo("should return error when upstream returns 4xx responses");
  });

  describe("setupAccessTokenAutoRefreshRecurring", () => {
    it.todo("should set up recurring access token refresh successfully");
    it.todo("should return error when response body is not in expected format");
  });

  describe("startCharging", () => {
    it.todo("should return void when command is successful");
    it.todo("should return void when car is already charging");
    it.todo("should retry with exponential backoff when command execution times out");
    it.todo("should return error when vehicle is asleep");
    it.todo("should return error when command fails for other reasons");
  });

  describe("stopCharging", () => {
    it.todo("should return void when command is successful");
    it.todo("should return void when car is already not charging");
  });

  describe("setAmpere", () => {
    it.todo("should set ampere successfully given valid input");
    it.todo("should return error given invalid ampere value");
    it.todo("should retry with exponential backoff when command execution times out");
    it.todo("should return error when vehicle is asleep");
    it.todo("should return error when command fails for other reasons");
  });

  describe("wakeUpCar", () => {
    it.todo("should wake up car successfully");
    it.todo("should return VehicleCommandFailedError should be returned if car is still asleep");
    it.todo("should return error when command fails for other reasons");
  });

  describe("getChargeState", () => {
    it.todo("should fetch charge state successfully");
    it.todo("should retry with exponential backoff when query times out");
    it.todo("should retry with exponential backoff when network connectivity issues occur");
    it.todo("should return error API returns 5xx errors");
    it.todo("should return error when response body is not in expected format");
  });
});
