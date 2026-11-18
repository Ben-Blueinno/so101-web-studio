# SO-101 Web Studio

The browser simulator supports Python routes, browser-local saves, and downloads. Choose **Robot mode** in **Start here**. Switching between one and two followers loads the matching starter after warning about unsaved edits. The right-hand viewer plays the starter, and the header shows the active mode and USB connection status. Future modes are disabled in the selector. Their Coming soon entries show requirements. Use the **Codebook** switch in **Simulation** to open Python examples and motor ranges. The 3D preview moves below the editor. The Python route parser runs locally in the browser using Pyodide.

Web Studio uses CodeMirror 5.65.21 for Python syntax highlighting and completion. Use several joint keys in the same `robot.send_action({...})` call to move them together in the simulator or through direct USB. The local bridge supports calibration and single-joint moves. After calibrating, reconnect by USB to deploy grouped moves.

Open **Start here** for the four steps. Use **Show me how** on each tab for its guide. In desktop Chrome or Edge, open **USB connection**, select follower A, then choose **Connect by USB** and pick its adapter. In two-follower mode, use **Active follower** above the tabs or the USB connection cards to select A · Right or B · Left, then connect each arm’s own adapter. The selection also applies to calibration, settings, pose and rest controls, and unprefixed Python keys. Single-follower mode uses A throughout. Both connected arms appear in **Simulation** and **Deployment**. Calibrate one arm at a time with both disconnected in Studio. Each follower keeps its own calibration draft, profile, and saved rest pose.

Unprefixed targets use the selected follower. Prefix keys with `A.` or `B.` to choose an arm in code. Targets in the same call run in one step.

```python
def route(robot):
    robot.send_action({"A.wrist_roll.pos": -5, "B.wrist_roll.pos": 5})
    robot.send_action({"A.wrist_roll.pos": 0, "B.wrist_roll.pos": 0})
```

Preview with your teacher, then select **Prepare deployment** and review each follower’s targets. Check both full paths and the space between the arms. The shared dual-arm preview uses the mount spacing and orientation from [XLeRobot’s ManiSkill URDF](https://github.com/Vector-Wangel/XLeRobot/blob/de51ed34cfe29ba1ca6d910a8e656fff6fd949ae/simulation/Maniskill/assets/xlerobot/xlerobot.urdf) at tabletop height. Both arms face forward, with their base origins 266 mm apart. Follower A is on the robot’s right and follower B on its left. Review both paths yourself since the preview lacks collision detection. **Stop route** stops the active step on both followers. The standalone LeRobot export supports one follower.

In **Calibration**, use **Calibrate new** to capture the midpoint and usable range on an assembled SO-101. Studio assigns the verified file to that follower. When the profile shows Default, direct USB reads calibration from the connected motors. To restore a calibration, choose the follower in **USB connection**. In **Calibration**, import and save the same arm’s JSON, choose **Use for this follower**, then choose **Restore saved calibration**. **Settings** holds each follower’s LeRobot ID and joint directions. For access to old local profiles, the [legacy Studio bridge](SO101-Studio-Bridge.zip) remains available.

The packed geometry and joint frames are adapted from the [SO-101 ROS 2 project](https://github.com/adoodevv/so101_ros2/tree/3fb5182614b8e672ab8784b2a10b50656f976c9c). The browser model quantizes the mesh coordinates and removes degenerate or duplicate triangles. See the [geometry licenses](LICENSE-so101-ros2.txt) and [mesh license](LICENSE-meshes.txt).
