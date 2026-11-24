package com.crewline.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (phone GPS with fake-location check); registered before the bridge starts.
        registerPlugin(CrewlineDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
