#!/usr/bin/env python3

# import statsmodels as sm
import pmdarima as pm
import numpy as np


class ArimaPredictor:
    """Custom ARIMA predictor which can be created from fitted pmdarima.ARIMA
    model.

    Unlike the original model, this one can only predict the future but only
    has to remember a constant number of latest observations (Depending on
    model orders). It also supports adding new observations without refitting.
    """

    def __init__(self, model, data):
        """Create an instance of ARIMA predictor from existing instance of
        pmdarima.ARIMA

        Args:
            model (pmdarima.ARIMA): Existing fitted model
            data (array-like of float): Data on which the model was fitted
        """
        self.data = data
        self.residuals = []
        self.intercept = 0
        self.ar_params = []
        self.ma_params = []
        self.d = 0
        if isinstance(model, pm.arima.ARIMA):
            self.residuals = np.array(model.resid())
            if model.with_intercept:
                self.intercept = model.params()[0]
            if model.order[0] > 0:
                self.ar_params = np.array(model.arparams())
            if model.order[1] > 0:
                self.d = model.order[1]
            if model.order[2] > 0:
                self.ma_params = np.array(model.maparams())
        else:
            print("Unsupported model given")

        self.max_size = self.d + max(len(self.ar_params),
                                     len(self.ma_params))
        """The count of observations we have to remember to be able to forecast
        """

        self.shrink()  # throw away unneeded observations

    def _add1(self, x):  # add a new observation `x` to the model
        prediction = self.predict(1)[0]
        residual = (x - prediction)

        # Note: append creates copy of the whole array
        self.data = np.append(self.data, x)
        self.residuals = np.append(self.residuals, residual)

    def append(self, observations):  # add array of new observations
        """Add new observations to the model

        Args:
            observations (array-like of float): New observations
        """
        # we add these observations by one, so that we can calculate one ahead
        # predictions for calculating residuals

        # alternatively, we could calculate all predictions before adding new
        # observations but that would mean
        for x in observations:
            self._add1(x)

        self.shrink()

    def append_predict(self, observations):
        """Add new observations to the model and return their model predictions
        (before they were known)

        Args:
            observations (list of float): New observed values

        Returns:
            list of float: Predicted values
        """
        predictions = []
        for x in observations:
            predictions.append(self.predict(1))
            self._add1(x)

        self.shrink()
        return predictions

    def _predict1(self, intercept, data, residuals):
        data_tmp = np.array(data)
        resid_tmp = np.array(residuals)
        data2 = [data_tmp]

        res = intercept

        for d in range(self.d):
            data_tmp = data_tmp[1:] - data_tmp[:-1]
            data2.append(data_tmp)

        if len(self.ar_params) > 0:
            obs = np.flip(data_tmp[-len(self.ar_params):])
            x = self.ar_params * obs
            res += np.sum(x)

        if len(self.ma_params) > 0:
            rsd = np.flip(resid_tmp[-len(self.ma_params):])
            x = self.ma_params * rsd
            res += np.sum(x)

        for d in reversed(range(self.d)):
            res = data2[d][-1] + res

        return res

    def predict(self, count=1):
        """Predict future values

        Args:
            count (int, optional): How many values. Defaults to 1.

        Returns:
            [type]: A list of predicted values
        """
        predictions = []
        for _ in range(count):
            data = list(self.data) + list(predictions)
            # new residuals are zero, because we are using predicted values in
            # place of 'past' values
            residuals = list(self.residuals) + [0 for _ in predictions]
            p = self._predict1(self.intercept, data, residuals)
            predictions.append(p)

        return predictions

    def shrink(self):
        """Delete unneeded observations
        """
        if len(self.data) > self.max_size:
            self.data = self.data[-self.max_size:]
            self.residuals = self.residuals[-self.max_size:]


if __name__ == "__main__":
    pass
