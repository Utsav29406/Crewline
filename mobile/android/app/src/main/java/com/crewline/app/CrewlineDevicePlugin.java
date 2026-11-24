package com.crewline.app;

import android.Manifest;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Location for punches, read from Android itself. Unlike the browser's location, Android reports whether the fix
 * came from a "mock location" app (fake GPS), which the server then refuses.
 *
 * JS: Capacitor.Plugins.CrewlineDevice.getLocation({ timeoutMs }) → { lat, lng, accuracy, mock }
 */
@CapacitorPlugin(
    name = "CrewlineDevice",
    permissions = { @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }) }
)
public class CrewlineDevicePlugin extends Plugin {

    @PluginMethod
    public void getLocation(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermission");
            return;
        }
        fetch(call);
    }

    @PermissionCallback
    private void locationPermission(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) fetch(call);
        else call.reject("Location permission denied");
    }

    private static boolean isMock(Location l) {
        if (Build.VERSION.SDK_INT >= 31) return l.isMock();
        return l.isFromMockProvider();
    }

    private void resolve(PluginCall call, Location l) {
        JSObject r = new JSObject();
        r.put("lat", l.getLatitude());
        r.put("lng", l.getLongitude());
        r.put("accuracy", l.hasAccuracy() ? l.getAccuracy() : 9999);
        r.put("mock", isMock(l));
        r.put("time", l.getTime());
        call.resolve(r);
    }

    @SuppressWarnings({ "MissingPermission", "deprecation" })
    private void fetch(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) { call.reject("Location is not available"); return; }
        String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER
            : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER : null;
        if (provider == null) { call.reject("Turn on Location in your phone settings"); return; }
        long timeout = call.getLong("timeoutMs", 15000L);
        Handler main = new Handler(Looper.getMainLooper());
        final boolean[] done = { false };

        if (Build.VERSION.SDK_INT >= 30) {
            CancellationSignal cancel = new CancellationSignal();
            main.postDelayed(() -> { if (!done[0]) { done[0] = true; cancel.cancel(); call.reject("Couldn't get a GPS fix. Move near a window and try again."); } }, timeout);
            lm.getCurrentLocation(provider, cancel, getContext().getMainExecutor(), (Location l) -> {
                if (done[0]) return;
                done[0] = true;
                if (l == null) call.reject("Couldn't get a GPS fix. Move near a window and try again.");
                else resolve(call, l);
            });
            return;
        }
        LocationListener listener = new LocationListener() {
            @Override public void onLocationChanged(Location l) {
                if (done[0]) return;
                done[0] = true;
                lm.removeUpdates(this);
                resolve(call, l);
            }
            @Override public void onStatusChanged(String p, int s, Bundle b) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
        };
        lm.requestSingleUpdate(provider, listener, Looper.getMainLooper());
        main.postDelayed(() -> { if (!done[0]) { done[0] = true; lm.removeUpdates(listener); call.reject("Couldn't get a GPS fix. Move near a window and try again."); } }, timeout);
    }
}
